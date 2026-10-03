/* ═══════════════════════════════════════════════════════════════
   Livre Conductor — app.js
   Toda la lógica: auth, viajes, GPS, estados.
   Las llamadas al backend están separadas en una sección clara.
   Hermes conecta: loadTrips(), changeStatus(), sendLocation().
═══════════════════════════════════════════════════════════════ */

/* ── Config ─────────────────────────────────────────────────── */
const DEFAULT_API = 'https://livre-cloud-production.up.railway.app';
function validatedHttpsApi(value) {
  if (!value) return DEFAULT_API;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
      return DEFAULT_API;
    return url.href.replace(/\/$/, '');
  } catch (_) {
    return DEFAULT_API;
  }
}
const API = validatedHttpsApi(new URLSearchParams(location.search).get('api'));

/* ── Estado global ──────────────────────────────────────────── */
let token       = localStorage.getItem('livre_driver_token');
let trips       = [];
let selected    = null;
let watchId     = null;
let wakeLock    = null;
let gpsRecoveryTimer = null;
let marker      = null;
let map         = null;
let lastAlerted = null;
let initialTripsLoaded = false;
let tripsRequestInFlight = false;
let pendingNativeTripId = null;
let authMode    = 'login';
const NATIVE_SHELL = !!window.AndroidGps;

/* ══════════════════════════════════════════════════════════════
   MODO DEMO
   ─────────────────────────────────────────────────────────────
   Activado cuando el usuario ingresa demo / demo.
   • No hace ninguna llamada al backend.
   • Simula el flujo completo: assigned → arriving → in_progress → completed.
   • Para desactivarlo: setDemoMode(false) o recargar la página.
   Hermes no necesita tocar este bloque.
══════════════════════════════════════════════════════════════ */
let DEMO = false;

const DEMO_TRIP = {
  id:          'DEMO-001',
  origin:      'Av. Alem 945, Bahía Blanca',
  destination: 'Ruta Provincial 51, Km 7',
  fare:        4800,
  status:      'assigned',
};

function setDemoMode(active) {
  DEMO = active;
  if (active) {
    // Banner visible en topbar para que quede claro que es demo
    const pill = document.getElementById('gpsPill');
    if (pill) {
      pill.title = 'MODO DEMO — sin backend';
    }
    console.info('[DEMO] Modo demo activo. Sin llamadas al backend.');
  }
}

/** En modo DEMO simula cambio de estado localmente */
function demoChangeStatus(status) {
  DEMO_TRIP.status = status;
  selected = { ...DEMO_TRIP };
  trips = [selected];
  render();
}

/** En modo DEMO simula GPS con coordenadas fijas de Bahía Blanca */
function demoStartGps() {
  // Posición inicial: centro de Bahía Blanca
  const lat = -38.7183;
  const lng = -62.2663;
  setMapMarker(lat, lng);
  updateGpsPill(true);
  // Pequeño drift visual para que el marcador "se mueva"
  let tick = 0;
  const demoGpsInterval = setInterval(() => {
    if (!DEMO) { clearInterval(demoGpsInterval); return; }
    tick++;
    setMapMarker(lat + (Math.random() - 0.5) * 0.001,
                 lng + (Math.random() - 0.5) * 0.001);
  }, 4000);
}

/* ── Utils ──────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const h  = ()  => ({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' });
const esc = v  => String(v || '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

function showNotice(msg) {
  const el = $('notice');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearNotice() { $('notice')?.classList.add('hidden'); }

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-AR'; u.rate = .94;
  speechSynthesis.speak(u);
}

function beep() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(170, now + .28);
    gain.gain.setValueAtTime(.001, now);
    gain.gain.exponentialRampToValueAtTime(.42, now + .015);
    gain.gain.exponentialRampToValueAtTime(.001, now + .3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + .31);
    osc.addEventListener('ended', () => ctx.close(), { once: true });
  } catch(e) {}
}

/* ── Formatear tarifa ───────────────────────────────────────── */
function formatFare(t) {
  const v = t?.fare;
  if (v == null || v === '') return null;
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(v));
}

function serviceTypeLabel(t) {
  if (t?.service_type_name) return t.service_type_name;
  return String(t?.service_type_id) === '1' ? 'Premium' : String(t?.service_type_id) === '2' ? 'Ahorro' : null;
}

/* ══════════════════════════════════════════════════════════════
   RENDER — la pantalla cambia según el estado del viaje
══════════════════════════════════════════════════════════════ */
const STATUS_LABEL = {
  assigned:    'Viaje recibido',
  arriving:    'En camino al pasajero',
  in_progress: 'Viaje en curso',
  completed:   'Viaje finalizado',
  cancelled:   'Viaje cancelado',
};

const ACTION_LABEL = {
  arriving:    '→ INICIAR VIAJE',
  in_progress: '✓ FINALIZAR VIAJE',
};

function render() {
  clearNotice();

  // Resolvemos qué viaje mostrar
  const t = (selected?.status === 'cancelled' || selected?.status === 'completed')
            ? null
            : selected || trips.find(x => x.status === 'assigned');

  const sheet  = $('sheet');
  const inner  = $('sheetInner');

  // ── Sin viaje ────────────────────────────────────────────── */
  if (!t) {
    sheet.className = 'sheet';
    inner.innerHTML = `
      <div class="idle-state">
        <div class="idle-icon">🚕</div>
        <div class="idle-title">Esperando un viaje</div>
        <p class="idle-sub">Cuando la central te asigne un viaje aparece acá automáticamente.</p>
        ${DEMO
          ? `<button class="btn-refresh" onclick="demoReset()">↩ Reiniciar demo</button>`
          : `<button class="btn-refresh" onclick="loadTrips()">Actualizar</button>`}
      </div>
      <div id="notice" class="notice hidden"></div>`;
    return;
  }

  selected = t;
  const st = t.status;

  // ── Viaje asignado (alerta) ──────────────────────────────── */
  if (st === 'assigned') {
    sheet.className = 'sheet alert-mode';
    const fare = formatFare(t);
    inner.innerHTML = `
      <div class="trip-alert">
        <div class="alert-badge">
          <span class="alert-pulse"></span>
          ${DEMO ? '🧪 DEMO — ' : ''}Viaje recibido
        </div>
        <div class="alert-title">¿Aceptás este viaje?</div>

        <div class="route-card">
          <div class="route-stop">
            <div class="stop-marker">
              <span class="stop-dot origin"></span>
              <span class="stop-line"></span>
            </div>
            <div>
              <div class="stop-label">Origen</div>
              <div class="stop-address">${esc(t.origin)}</div>
            </div>
          </div>
          <div class="route-stop">
            <div class="stop-marker">
              <span class="stop-dot dest"></span>
            </div>
            <div>
              <div class="stop-label">Destino</div>
              <div class="stop-address">${esc(t.destination)}</div>
            </div>
          </div>
        </div>

        <div class="fare-row">
          <span class="fare-label">Tipo de servicio</span>
          <span class="fare-value">${serviceTypeLabel(t) ? esc(serviceTypeLabel(t)) : 'No informado'}</span>
        </div>
        <div class="fare-row">
          <span class="fare-label">Tarifa del viaje</span>
          ${fare
            ? `<span class="fare-value">${fare}</span>`
            : `<span class="fare-value unknown">No informada</span>`}
        </div>

        <div class="alert-actions">
          <button class="btn-accept" onclick="acceptTrip()">✓ ACEPTAR</button>
          <button class="btn-reject" onclick="rejectTrip()">✕ Rechazar</button>
        </div>
      </div>
      <div id="notice" class="notice hidden"></div>`;
    return;
  }

  // ── Viaje en curso / en camino ───────────────────────────── */
  sheet.className = 'sheet active-mode';

  const isArriving   = st === 'arriving';
  const isInProgress = st === 'in_progress';
  const isCompleted  = st === 'completed';

  let statusHtml = '';
  if (isArriving)    statusHtml = `<div class="active-status"><span class="active-status-dot"></span><span class="active-status-text">${DEMO ? '🧪 DEMO — ' : ''}En camino al pasajero — GPS activo</span></div>`;
  if (isInProgress)  statusHtml = `<div class="active-status amber"><span class="active-status-dot"></span><span class="active-status-text">${DEMO ? '🧪 DEMO — ' : ''}Viaje en curso — GPS activo</span></div>`;
  if (isCompleted)   statusHtml = `<div class="active-status"><span class="active-status-dot" style="background:#8b8d96;box-shadow:none"></span><span class="active-status-text" style="color:#8b8d96">Viaje finalizado</span></div>`;

  let primaryBtn = '';
  if (isArriving)    primaryBtn = `<button class="btn-primary green" onclick="nextStatus()">LLEGUÉ — Iniciar viaje</button>`;
  if (isInProgress)  primaryBtn = `<button class="btn-primary" onclick="nextStatus()">Finalizar viaje</button>`;
  if (isCompleted)   primaryBtn = `<button class="btn-primary" disabled>Viaje finalizado</button>`;

  inner.innerHTML = `
    <div class="active-trip">
      ${statusHtml}

      <div class="trip-summary">
        <div class="trip-row">
          <span class="trip-row-icon">📍</span>
          <div class="trip-row-text">
            <small>Origen</small>
            ${esc(t.origin)}
          </div>
        </div>
        <div class="trip-row">
          <span class="trip-row-icon">🏁</span>
          <div class="trip-row-text">
            <small>Destino</small>
            ${esc(t.destination)}
          </div>
        </div>
      </div>

      <div class="primary-actions">${primaryBtn}</div>

      <div class="secondary-actions">
        <button class="btn-tool" id="btnHandy" title="Conectar con operador">
          📻 Handy
        </button>
        <button class="btn-tool" id="btnVoice" title="Conducción por voz con Libi">
          🎙️ Libi
        </button>
      </div>
    </div>
    <div id="notice" class="notice hidden"></div>`;

  // Botones secundarios — UI lista, lógica para Hermes
  $('btnHandy').onclick = () => {
    // TODO (Hermes): abrir canal Handy / POST /mobility/driver/handie
    showNotice('Canal Handy — próximamente disponible.');
  };
  $('btnVoice').onclick = () => {
    // TODO (Hermes): activar conducción por voz con Libi / ElevenLabs
    showNotice('Conducción por voz — próximamente disponible.');
  };
}

/* ══════════════════════════════════════════════════════════════
   ACCIONES DE VIAJE
══════════════════════════════════════════════════════════════ */
async function acceptTrip() {
  const changed = await changeStatus('arriving');
  if (!changed) return;
  startGps();
  speak('Viaje aceptado. Comenzando a compartir ubicación.');
}

async function rejectTrip() {
  if (!confirm('¿Rechazar este viaje?')) return;
  await changeStatus('cancelled');
}

async function nextStatus() {
  if (!selected) return;
  const next = { arriving: 'in_progress', in_progress: 'completed' }[selected.status];
  if (!next) return;
  await changeStatus(next);
}

/** Solo en DEMO: reinicia el viaje mock para poder recorrer el flujo de nuevo */
function demoReset() {
  DEMO_TRIP.status = 'assigned';
  selected = { ...DEMO_TRIP };
  trips = [selected];
  lastAlerted = null;
  announceNewTrip(selected);
  render();
}

/* ══════════════════════════════════════════════════════════════
   BACKEND CALLS — Hermes conecta estas funciones al API real
   En DEMO todas retornan inmediatamente sin tocar la red.
══════════════════════════════════════════════════════════════ */

/** Carga los viajes asignados al conductor */
async function loadTrips() {
  // Nunca consultar viajes desde el login: sin token el API responde 401,
  // y logout() recarga la página, generando un ciclo de recargas.
  if (!token || $('appView')?.classList.contains('hidden')) return false;
  if (NATIVE_SHELL && document.visibilityState !== 'visible') return false;
  if (tripsRequestInFlight) return false;
  tripsRequestInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);
  try {
    // ── DEMO ────────────────────────────────────────────────────
    if (DEMO) {
      trips   = [{ ...DEMO_TRIP }];
      selected = trips[0];
      render();
      initialTripsLoaded = true;
      resolvePendingNativeTrip();
      return true;
    }
    // ── REAL ────────────────────────────────────────────────────
    clearNotice();
    const r = await fetch(`${API}/mobility/driver/trips?_=${Date.now()}`, {
      headers: h(),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    trips = await r.json();
    if (selected) selected = trips.find(t => t.id === selected.id) || null;
    if (!selected && trips.length)
      selected = trips.find(t => t.status === 'assigned') || trips[0];
    render();
    const fresh = trips.find(t => t.status === 'assigned');
    if (initialTripsLoaded && fresh) announceNewTrip(fresh);
    initialTripsLoaded = true;
    resolvePendingNativeTrip();
    return true;
  } catch(e) {
    showNotice('No se pudieron cargar los viajes. Revisá la conexión.');
    return false;
  } finally {
    clearTimeout(timeoutId);
    tripsRequestInFlight = false;
  }
}

/** Cambia el estado de un viaje */
async function changeStatus(status) {
  // ── DEMO ────────────────────────────────────────────────────
  if (DEMO) {
    demoChangeStatus(status);
    return true;
  }
  // ── REAL ────────────────────────────────────────────────────
  if (!selected) return false;
  try {
    const r = await fetch(`${API}/mobility/driver/trips/${selected.id}/status`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ status }),
    });
    const statusCode = r.status;
    if (!r.ok) {
      if (statusCode === 409) {
        const lostTripId = selected.id;
        trips = trips.filter(t => t.id !== lostTripId);
        selected = null;
        render();
        showNotice('Ese viaje ya fue tomado por otro conductor.');
        loadTrips();
        return false;
      }
      throw Error(statusCode);
    }
    selected = await r.json();
    trips = trips.map(t => t.id === selected.id ? selected : t);
    render();
    return true;
  } catch(e) {
    showNotice('No se pudo actualizar el estado del viaje.');
    return false;
  }
}

/** Envía una posición GPS al backend */
async function sendLocation(lat, lng) {
  setMapMarker(lat, lng);
  // ── DEMO ────────────────────────────────────────────────────
  if (DEMO) {
    updateGpsPill(true);
    return;
  }
  // ── REAL ────────────────────────────────────────────────────
  const body = JSON.stringify({ latitude: lat, longitude: lng });
  try {
    const liveResponse = await fetch(`${API}/mobility/driver/location`, {
      method: 'POST', headers: h(), body,
    });
    if (!liveResponse.ok) throw Error(`driver-location:${liveResponse.status}`);

    if (selected && ['assigned','arriving','in_progress'].includes(selected.status)) {
      const tripResponse = await fetch(`${API}/mobility/driver/trips/${selected.id}/location`, {
        method: 'POST', headers: h(), body,
      });
      if (!tripResponse.ok) throw Error(`trip-location:${tripResponse.status}`);
    }
    updateGpsPill(true);
  } catch(e) {
    updateGpsPill(false);
    showNotice('No se pudo enviar la ubicación GPS al backend.');
  }
}

/* ══════════════════════════════════════════════════════════════
   GPS
══════════════════════════════════════════════════════════════ */
async function requestGpsWakeLock() {
  if (DEMO || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {
    wakeLock = null;
  }
}

function restartGpsAfterBackground() {
  if (DEMO || !token || !$('appView') || $('appView').classList.contains('hidden')) return;
  requestGpsWakeLock();
  if (watchId === null) startGps();
  else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => sendLocation(p.coords.latitude, p.coords.longitude),
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }
}

function startGps() {
  // ── DEMO ────────────────────────────────────────────────────
  if (DEMO) { demoStartGps(); return; }
  if (NATIVE_SHELL) { updateGpsPill(true); return; }
  // ── REAL ────────────────────────────────────────────────────
  if (watchId !== null) return;
  updateGpsPill(null);
  if (!navigator.geolocation) {
    showNotice('Este navegador no permite GPS. Habilitá la ubicación del navegador.');
    return;
  }
  requestGpsWakeLock();
  const opts = { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 };
  const onPos = p => sendLocation(p.coords.latitude, p.coords.longitude);
  const onErr = e => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    updateGpsPill(false);
    showNotice(e.code === 1
      ? 'Permiso de GPS denegado. Habilitalo en el navegador y recargá.'
      : 'No se pudo obtener GPS. Verificá la señal.');
  };
  navigator.geolocation.getCurrentPosition(onPos, onErr, opts);
  watchId = navigator.geolocation.watchPosition(onPos, onErr, opts);
  if (!gpsRecoveryTimer) {
    gpsRecoveryTimer = setInterval(() => {
      if (document.visibilityState === 'visible') restartGpsAfterBackground();
    }, 60000);
  }
}

function stopGps() {
  if (DEMO) { updateGpsPill(false); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (gpsRecoveryTimer) clearInterval(gpsRecoveryTimer);
  gpsRecoveryTimer = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  updateGpsPill(false);
}

function updateGpsPill(active) {
  const pill = $('gpsPill');
  const label = $('gpsLabel');
  if (!pill || !label) return;
  if (active === null) {
    pill.className = 'gps-pill inactive';
    label.textContent = 'Solicitando GPS…';
  } else if (active) {
    pill.className = 'gps-pill';
    label.textContent = DEMO ? 'GPS demo' : 'GPS activo';
  } else {
    pill.className = 'gps-pill inactive';
    label.textContent = 'GPS inactivo';
  }
}

/* ══════════════════════════════════════════════════════════════
   MAPA
══════════════════════════════════════════════════════════════ */
function initMap() {
  map = L.map('map', { zoomControl: false })
          .setView([-38.718, -62.266], 14);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
}

function setMapMarker(lat, lng) {
  if (!map) return;
  const pos = [lat, lng];
  if (!marker) {
    marker = L.circleMarker(pos, {
      radius: 10,
      fillColor: '#2de08b',
      fillOpacity: 1,
      color: '#07080a',
      weight: 3,
    }).addTo(map);
  } else {
    marker.setLatLng(pos);
  }
  map.setView(pos, Math.max(map.getZoom(), 15));
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICACIÓN DE VIAJE NUEVO
══════════════════════════════════════════════════════════════ */
function announceNewTrip(t) {
  if (!t || lastAlerted === t.id) return;
  lastAlerted = t.id;
  beep();
  speak(`Nuevo viaje disponible. Origen: ${t.origin}. Destino: ${t.destination}.`);
}

function onNativeTripNotification(tripId) {
  if (!tripId) return false;
  const id = String(tripId);
  if (applyNativeTrip(id)) return true;
  pendingNativeTripId = id;
  loadTrips();
  return false;
}

function applyNativeTrip(tripId) {
  const found = trips.find(t => String(t.id) === String(tripId));
  if (!found) return false;
  if (found.status === 'cancelled' || found.status === 'completed') {
    showNotice('Ese viaje ya no está disponible.');
    window.AndroidGps?.confirmTripUnavailable?.(String(tripId));
    return true;
  }
  selected = found;
  render();
  lastAlerted = found.id;
  window.AndroidGps?.confirmTripOpened?.(String(tripId));
  return true;
}

function resolvePendingNativeTrip() {
  if (!pendingNativeTripId) return;
  const id = pendingNativeTripId;
  pendingNativeTripId = null;
  if (applyNativeTrip(id)) return;
  showNotice('Ese viaje ya fue tomado por otro conductor.');
  window.AndroidGps?.confirmTripUnavailable?.(id);
}

function onNativeSessionExpired() {
  logout();
  return true;
}

function onNativePermissionState(state) {
  const messages = {
    NEED_PRECISE_LOCATION: 'Habilitá la ubicación precisa para compartir tu posición.',
    NEED_BACKGROUND_LOCATION: 'Habilitá ubicación “Permitir todo el tiempo” para operar en segundo plano.',
    NEED_NOTIFICATIONS: 'Habilitá las notificaciones para recibir nuevos viajes.',
    LOCATION_DISABLED: 'Activá el GPS del dispositivo para compartir tu posición.',
  };
  if (messages[state]) showNotice(messages[state]);
  return true;
}

/* ══════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════ */
function setAuthMode(mode) {
  // Las cuentas las crea Livre a partir del padrón de choferes.
  authMode = 'login';
  $('authTitle').textContent  = 'Hola de nuevo';
  $('authSub').textContent    = 'Ingresá con tu cuenta de conductor Livre.';
  $('nameField').classList.add('hidden');
  $('nameInput').required     = false;
  $('submitBtn').textContent  = 'Ingresar';
  $('toggleAuth').classList.add('hidden');
  $('loginError').classList.add('hidden');
}

async function login(e) {
  e.preventDefault();
  $('loginError').classList.add('hidden');

  const user = $('username').value.trim();
  const pass = $('password').value;

  // ── DEMO ────────────────────────────────────────────────────
  if (user === 'demo' && pass === 'demo') {
    setDemoMode(true);
    openApp({ name: 'Conductor Demo' });
    return;
  }
  // ── REAL ────────────────────────────────────────────────────
  const reg = false;
  try {
    const body = { username: user, password: pass };
    if (reg) body.name = $('nameInput').value.trim();
    const endpoint = reg ? '/auth/driver/register' : '/auth/driver/login';
    const r    = await fetch(API + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw Error(data.detail || 'No se pudo completar la operación');
    token = data.token;
    localStorage.setItem('livre_driver_token', token);
    openApp(data.user || {});
  } catch(err) {
    $('loginError').textContent = err.message || 'Error de conexión';
    $('loginError').classList.remove('hidden');
  }
}

function startNativeBackgroundLocation() {
  if (DEMO || !token || !window.AndroidGps) return;
  try { window.AndroidGps.startLocation(token, API); } catch (e) { console.warn('native GPS unavailable', e); }
}

function stopNativeBackgroundLocation() {
  if (window.AndroidGps) {
    try { window.AndroidGps.stopLocation(); } catch (e) {}
  }
}

function setNativeAppVisible(visible) {
  if (!NATIVE_SHELL || !window.AndroidGps?.setAppVisible) return;
  try { window.AndroidGps.setAppVisible(visible); } catch (e) {}
}

function openApp(user = {}) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  initMap();
  startNativeBackgroundLocation();
  if (!NATIVE_SHELL) startGps();
  else updateGpsPill(true);
  loadTrips();
}

function logout() {
  stopGps();
  stopNativeBackgroundLocation();
  if (window.AndroidGps?.clearSession) {
    try { window.AndroidGps.clearSession(); } catch (e) {}
  }
  DEMO = false;
  localStorage.removeItem('livre_driver_token');
  location.reload();
}

/* ── Bootstrap ──────────────────────────────────────────────── */
$('loginForm').onsubmit  = login;
$('toggleAuth').onclick  = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('logoutBtn').onclick   = logout;

document.addEventListener('visibilitychange', () => {
  setNativeAppVisible(document.visibilityState === 'visible');
  if (document.visibilityState === 'visible') {
    restartGpsAfterBackground();
    loadTrips();
  }
});
window.addEventListener('pageshow', () => {
  restartGpsAfterBackground();
  loadTrips();
});
window.addEventListener('online', () => {
  restartGpsAfterBackground();
  loadTrips();
});

if (token) openApp();

// Polling cada 5 segundos (en DEMO no hace llamadas al backend)
setInterval(() => {
  if (!DEMO && token && !$('appView').classList.contains('hidden') &&
      (!NATIVE_SHELL || document.visibilityState === 'visible')) loadTrips();
}, 5000);
