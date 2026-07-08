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
const FILA     = Number(params.get("fila"));

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
const addToPadronBtn= document.getElementById("addToPadronBtn");

// ── Arranque ───────────────────────────────────────────────────────
init();

async function init() {
  if (!TOKEN || !FILA || Number.isNaN(FILA)) {
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

// ── Botón "Agregar al padrón" ──────────────────────────────────────
addToPadronBtn.addEventListener("click", async () => {
  const matricula = addToPadronBtn.dataset.matricula;
  if (!matricula) return;
  const nombre = prompt("Ingresa el nombre completo del alumno:", "");
  if (!nombre || !nombre.trim()) {
    showToast("Nombre requerido para agregar al padrón.");
    return;
  }
  // Intentar registrar de nuevo enviando el nombre (el backend lo crea si no existe)
  await registrar(matricula, nombre.trim(), true);
});

// ── Comunicación con Apps Script ───────────────────────────────────
// Se envía como text/plain (no application/json) para evitar el
// preflight CORS que Apps Script no soporta.
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

// ── Registrar asistencia (con soporte para alta automática) ───────
async function registrar(matricula, nombre = null, esReintento = false) {
  pendingRequest = true;
  addToPadronBtn.style.display = "none";

  try {
    const payload = { matricula };
    if (nombre) payload.nombre = nombre;
    const data = await callBackend("registrarAsistenciaQR", payload);
    setConn("ok", "Conectado");
    counterNum.textContent = data.total;

    // Si el alumno no fue encontrado en el padrón
    if (!data.encontrado) {
      // Si ya es un reintento con nombre, significa que el backend no pudo crear al alumno
      if (esReintento) {
        showResult("error", "No se pudo agregar al padrón", "Verifica que el nombre sea válido.");
        return;
      }
      // Mostrar opción para agregar al padrón
      showResult("dup", data.matricula, "No está en el padrón de alumnos.");
      // Guardar la matrícula para usarla al hacer clic en el botón
      addToPadronBtn.dataset.matricula = matricula;
      addToPadronBtn.style.display = "inline-block";
      return;
    }

    // Si es duplicado
    if (data.duplicado) {
      showResult("dup", data.nombre, "Ya estaba registrado — " + data.matricula);
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

// ── Botón "Terminar lista" ──────────────────────────────────────────
document.getElementById("finishBtn").addEventListener("click", () => {
  // Intenta cerrar la pestaña
  try {
    window.close();
  } catch (e) {
    // Si no se puede, redirige a la URL de Apps Script (o a la página de inicio)
    // Puedes cambiar esta URL por la de tu sistema de reservas
    const fallbackUrl = "https://script.google.com/macros/s/AKfycbwlILgqyqL7rejSvtIV9qL7qLzCAkeVuIrZLhmpJz8VpPGtPohaoECnCrfUBOUb3GJL7Q/exec";
    window.location.href = fallbackUrl;
  }
});

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

// Beep con Web Audio + vibración (silenciosa si no hay interacción)
let audioCtx = null;
function feedback() {
  // Sonido (siempre funciona)
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
  } catch (e) {
    // Audio no disponible, se ignora
  }

  // Vibración: se ejecuta solo si es posible y sin lanzar excepción
  if (navigator.vibrate) {
    try {
      navigator.vibrate(120);
    } catch (_) {
      // Si falla (por política de usuario), lo ignoramos
    }
  }
}

// Reconexión automática si la pestaña vuelve a estar visible
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && TOKEN && FILA) {
    bootstrapSesion();
    if (!stream) startCamera();
  }
});
