// =====================================================================
//  UPVT · Escáner QR de asistencia — scanner.js
//  Conecta con Code.gs (doPost). Requiere que la página se abra con
//  ?token=SESSION_TOKEN&fila=NUMERO_FILA  (enlace generado por el Dashboard)
// =====================================================================

// ⚠️ Reemplaza con la URL de tu Web App (la misma que devuelve getWebAppUrl()):
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwlILgqyqL7rejSvtIV9qL7qLzCAkeVuIrZLhmpJz8VpPGtPohaoECnCrfUBOUb3GJL7Q/exec";

const SCAN_COOLDOWN_MS = 2500;   // evita reenviar el mismo QR de inmediato
const RETRY_DELAY_MS   = 4000;   // reintento tras fallo de red

// ── Estado ─────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const TOKEN    = params.get("token");
const FILA     = Number(params.get("fila"));   // ← antes: params.get("fila") (string)

let stream = null;
let facingMode = "environment";
let scanning = false;
let lastCode = null;
let lastScanAt = 0;
let pendingRequest = false;

// ── DOM ────────────────────────────────────────────────────────────
const video         = document.getElementById("video");
const canvas        = document.getElementById("canvas");
const ctx           = canvas.getContext("2d", { willReadFrequently: true });
const frameEl       = document.getElementById("frame");
const resultCard    = document.getElementById("resultCard");
const resultState   = document.getElementById("resultState");
const resultName    = document.getElementById("resultName");
const resultMeta    = document.getElementById("resultMeta");
const counterNum    = document.getElementById("counterNum");
const contextLabel  = document.getElementById("contextLabel");
const connStatus    = document.getElementById("connStatus");
const switchCamBtn  = document.getElementById("switchCam");
const manualBtn     = document.getElementById("manualBtn");
const toastEl       = document.getElementById("toast");

// ── Arranque ───────────────────────────────────────────────────────
init();

async function init() {
  if (!TOKEN || !FILA || Number.isNaN(FILA)) {   // ← se agregó Number.isNaN(FILA)
    setConn("error", "Sin sesión");
    contextLabel.textContent = "Falta token o fila. Abre este escáner desde el Dashboard.";
    showResult("error", "Enlace incompleto", "Regresa al Dashboard y genera el enlace de la reserva de nuevo.");
    return;
  }
  await startCamera();
  await bootstrapSesion();
  requestAnimationFrame(tick);
}

// ── Cámara ─────────────────────────────────────────────────────────
async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    setConn("error", "Sin cámara");
    showResult("error", "No se pudo acceder a la cámara", err.message || "Revisa los permisos del navegador.");
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

switchCamBtn.addEventListener("click", () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  startCamera();
});

// ── Bucle de escaneo ───────────────────────────────────────────────
function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA && !pendingRequest) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });

    if (code && code.data) {
      const now = Date.now();
      const isSameRecent = code.data === lastCode && (now - lastScanAt) < SCAN_COOLDOWN_MS;
      if (!isSameRecent) {
        lastCode = code.data;
        lastScanAt = now;
        handleScan(code.data);
      }
    }
  }
  requestAnimationFrame(tick);
}

// ── Manejo de un código leído ──────────────────────────────────────
async function handleScan(rawValue) {
  frameEl.classList.add("locked");
  feedback();
  showResult("pending", "Registrando…", rawValue);
  await registrar(rawValue);
  setTimeout(() => frameEl.classList.remove("locked"), 700);
}

manualBtn.addEventListener("click", () => {
  const matricula = prompt("Matrícula del alumno:");
  if (matricula && matricula.trim()) handleScan(matricula.trim());
});

// ── Comunicación con Apps Script ───────────────────────────────────
// Se envía como text/plain (no application/json) para evitar el
// preflight CORS que Apps Script no soporta — mismo criterio que doPost().
async function callBackend(accion, extra) {
  const body = JSON.stringify({ accion, token: TOKEN, fila: FILA, ...extra });
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Error desconocido del servidor.");
  return json.data;
}

async function bootstrapSesion() {
  try {
    const sesion = await callBackend("validarToken");
    contextLabel.textContent = sesion.nombre + " · fila " + FILA;
    setConn("ok", "Conectado");
    const asistencia = await callBackend("getAsistenciaReserva");
    counterNum.textContent = asistencia.total;
  } catch (err) {
    setConn("error", "Sin conexión");
    showResult("error", "No se pudo validar la sesión", err.message);
  }
}

async function registrar(matricula) {
  pendingRequest = true;
  try {
    const data = await callBackend("registrarAsistenciaQR", { matricula });
    setConn("ok", "Conectado");
    counterNum.textContent = data.total;

    if (data.duplicado) {
      showResult("dup", data.nombre, "Ya estaba registrado — " + data.matricula);
    } else if (!data.encontrado) {
      showResult("dup", data.matricula, "Registrado, pero no está en el padrón de alumnos.");
    } else {
      showResult("ok", data.nombre, "Matrícula " + data.matricula + " · asistencia registrada");
    }
  } catch (err) {
    setConn("error", "Sin conexión");
    showResult("error", "No se pudo registrar", err.message);
    scheduleRetry(matricula);
  } finally {
    pendingRequest = false;
  }
}

function scheduleRetry(matricula) {
  setTimeout(async () => {
    try {
      await callBackend("validarToken");
      setConn("ok", "Conectado");
      showToast("Conexión recuperada. Vuelve a escanear el QR si no se registró.");
    } catch {
      setConn("error", "Sin conexión");
    }
  }, RETRY_DELAY_MS);
}

// ── UI helpers ─────────────────────────────────────────────────────
function showResult(state, name, meta) {
  resultCard.dataset.state = state === "pending" ? "" : state;
  resultState.textContent = {
    ok: "Asistencia registrada",
    dup: "Atención",
    error: "Error",
    pending: "Procesando…"
  }[state] || "";
  resultName.textContent = name;
  resultMeta.textContent = meta || "";
}

function setConn(state, label) {
  connStatus.dataset.state = state;
  connStatus.querySelector(".txt").textContent = label;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  setTimeout(() => { toastEl.hidden = true; }, 3000);
}

// Beep con Web Audio (no depende de un archivo .mp3) + vibración
let audioCtx = null;
function feedback() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.18);
  } catch (e) { /* audio no disponible, se ignora */ }

  if (navigator.vibrate) navigator.vibrate(120);
}

// Reconexión automática si la pestaña vuelve a estar visible
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && TOKEN && FILA) {
    bootstrapSesion();
    if (!stream) startCamera();
  }
});
