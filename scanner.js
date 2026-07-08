// =====================================================================
//  UPVT · Escáner QR de asistencia — scanner.js
// =====================================================================

// ⚠️ Reemplaza con la URL de tu Web App (termina en /exec)
// Asegúrate de que esté publicada como "Cualquier persona"
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwy7S_zRl-ubzYHS5nZxmfU6wuvcv3Qcanxabe7AW2mi8oQFMda3EPW9iRi8VBmbuKL/exec";

const SCAN_COOLDOWN_MS = 2500;
const RETRY_DELAY_MS   = 4000;

// ── Estado ─────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const TOKEN    = params.get("token");
const FILA     = Number(params.get("fila"));

let stream = null;
let facingMode = "environment";
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
  showResult("pending", "Matrícula: " + rawValue, "Registrando…");
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
  await registrar(matricula, nombre.trim(), true);
});

// ── Comunicación con Apps Script (directo) ────────────────────────
async function callBackend(accion, extra) {
  const body = JSON.stringify({ accion, token: TOKEN, fila: FILA, ...extra });
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body
  });

  // Si la respuesta no es OK, intentamos leer el texto de error
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Servidor respondió con error (${res.status}): ${text.substring(0, 100)}`);
  }

  // Intentar parsear JSON
  let json;
  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text();
    throw new Error(`Respuesta no es JSON válido: ${text.substring(0, 100)}`);
  }

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

async function registrar(matricula, nombre = null, esReintento = false) {
  pendingRequest = true;
  addToPadronBtn.style.display = "none";

  try {
    const payload = { matricula };
    if (nombre) payload.nombre = nombre;
    const data = await callBackend("registrarAsistenciaQR", payload);
    setConn("ok", "Conectado");
    counterNum.textContent = data.total;

    if (!data.encontrado) {
      if (esReintento) {
        showResult("error", "No se pudo agregar al padrón", "Verifica que el nombre sea válido.");
        return;
      }
      showResult("dup", data.matricula, "No está en el padrón de alumnos.");
      addToPadronBtn.dataset.matricula = matricula;
      addToPadronBtn.style.display = "inline-block";
      return;
    }

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
  try {
    window.close();
  } catch (e) {
    window.location.href = APPS_SCRIPT_URL;
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

// Beep + vibración (sin warnings)
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
  } catch (e) {}

  if (navigator.vibrate) {
    try { navigator.vibrate(120); } catch (_) {}
  }
}

// Reconexión automática
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && TOKEN && FILA) {
    bootstrapSesion();
    if (!stream) startCamera();
  }
});
