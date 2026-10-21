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

// Diagnóstico temporal: sólo métricas y estados, sin datos personales.
function diagLog(event, data = {}) {
  try { console.info('[LIVRE_DIAG]', JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch (_) {}
}

function validDeviceId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function stableDeviceId() {
  const key = 'livre_driver_device_id';
  if (window.AndroidGps) {
    const nativeValue = window.AndroidGps.getDeviceId?.();
    if (!validDeviceId(nativeValue)) throw new Error('Android device identity unavailable');
    try { localStorage.setItem(key, nativeValue); } catch (_) {}
    return nativeValue;
  }
  let value = localStorage.getItem(key);
  if (!validDeviceId(value)) {
    value = crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    localStorage.setItem(key, value);
  }
  return value;
}

const deviceId = stableDeviceId();

/* ── Estado global ──────────────────────────────────────────── */
let token       = localStorage.getItem('livre_driver_token');
let authEpoch   = 0;
let trips       = [];
let selected    = null;
// Se conserva fuera de la tarjeta para que un refresh de viajes no corte
// el envío del GPS del viaje aceptado.
let activeTripId = null;
let watchId     = null;
let wakeLock    = null;
let gpsRecoveryTimer = null;
let gpsHeartbeatTimer = null;
let gpsSuspended = false;
const GPS_HEARTBEAT_MS = 30000;
let lastNativeLocationAt = 0;
const gpsState = { provider: 'STOPPED', backend: 'UNKNOWN' };
let marker      = null;
let directionMarker = null;
let lastMapPosition = null;
let routeLine   = null;
let ownTraceLine = null;
let ownTracePoints = [];
let ownTraceTripId = '';
let routeRefreshTimer = null;
let map         = null;
let otherDriversLayer = null;
let otherDriversRequestInFlight = false;
let otherDriversTimer = null;
let currentDriverUserId = '';
const announcedTripIds = new Set();
const rejectedTripIds = new Set(JSON.parse(localStorage.getItem('livre_driver_rejected_trips') || '[]'));
let initialTripsLoaded = false;
let tripsRequestInFlight = false;
let tripsPollTimer = null;
let tripsPollEpoch = 0;
const TRIPS_POLL_MS = 5000;
let pendingNativeTripId = null;
let authMode    = 'login';
let operationalStatus = 'available';
let currentDriverSnapshot = null;
const PREFS_KEY = 'livre_driver_preferences';
const DEFAULT_PREFS = { theme: 'dark', tone: 'car_horn', volume: 70, fontScale: '1' };
let preferences = { ...DEFAULT_PREFS };

const OPERATIONAL_STATUS_LABELS = {
  available: '🟢 Disponible',
  unavailable: '⚪ No disponible',
  out_of_service: '🔴 Fuera de servicio',
};
const DRIVER_MARKER_COLORS = {
  available: '#2de08b',
  unavailable: '#9aa0aa',
  out_of_service: '#e8003d',
};

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
  gpsState.provider = 'ACTIVE';
  gpsState.backend = 'SYNCED';
  updateGpsPill();
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
const h  = ()  => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Device-ID': deviceId,
});
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

const TONE_SOURCES = {
  // MP3 covers Safari versions without Ogg/Vorbis support. Ogg remains as
  // a fallback for browsers that prefer it or cannot decode MP3.
  car_horn: ['assets/audio/car-horn.mp3', 'assets/audio/car-horn.ogg'],
  bus_horn: ['assets/audio/bus-horn.mp3', 'assets/audio/bus-horn.ogg'],
  truck_horn: ['assets/audio/truck-horn.mp3', 'assets/audio/truck-horn.ogg'],
};
const TONE_MIME_TYPES = { mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs="vorbis"' };

let alertAudio = null;
let alertAudioUnlocked = false;
let alertAudioUnlockPromise = null;

function toneSources(tone = preferences.tone) {
  return TONE_SOURCES[tone] || TONE_SOURCES.car_horn;
}

function supportedToneSource(tone = preferences.tone) {
  const probe = document.createElement('audio');
  return toneSources(tone).find(source => {
    const extension = source.split('.').pop();
    return !probe.canPlayType || probe.canPlayType(TONE_MIME_TYPES[extension]) !== '';
  }) || toneSources(tone)[0];
}

function createAlertAudio(tone = preferences.tone) {
  const audio = new Audio(supportedToneSource(tone));
  audio.preload = 'auto';
  audio.volume = Math.max(0, Math.min(1, Number(preferences.volume) / 100));
  return audio;
}

function unlockAlertAudio() {
  if (alertAudioUnlocked) return Promise.resolve(true);
  if (alertAudioUnlockPromise) return alertAudioUnlockPromise;
  try {
    alertAudio = createAlertAudio();
    alertAudio.volume = 0;
    alertAudioUnlockPromise = Promise.resolve(alertAudio.play()).then(() => {
      alertAudio.pause();
      alertAudio.currentTime = 0;
      alertAudio.volume = Math.max(0, Math.min(1, Number(preferences.volume) / 100));
      alertAudioUnlocked = true;
      diagLog('alert_audio_unlocked');
      return true;
    }).catch(e => {
      diagLog('alert_audio_unlock_failed', { error: String(e?.name || e?.message || e).slice(0, 80) });
      alertAudioUnlockPromise = null;
      return false;
    });
    return alertAudioUnlockPromise;
  } catch (e) {
    diagLog('alert_audio_create_failed', { error: String(e?.name || e?.message || e).slice(0, 80) });
    return Promise.resolve(false);
  }
}

async function beep() {
  try {
    const source = supportedToneSource();
    if (!alertAudio || alertAudio.src !== new URL(source, location.href).href) {
      alertAudio = createAlertAudio();
      alertAudioUnlocked = false;
      alertAudioUnlockPromise = null;
    }
    if (!alertAudioUnlocked) {
      const unlocked = await unlockAlertAudio();
      if (!unlocked) throw Error('audio_locked');
    }
    alertAudio.volume = Math.max(0, Math.min(1, Number(preferences.volume) / 100));
    alertAudio.currentTime = 0;
    await alertAudio.play();
    console.info('[ALERT] web audio played', preferences.tone);
    return true;
  } catch (e) {
    diagLog('alert_audio_play_failed', { error: String(e?.name || e?.message || e).slice(0, 80) });
    console.warn('[ALERT] web audio blocked', e);
    return false;
  }
}

function installAudioGestureUnlock() {
  const events = ['pointerdown', 'touchstart', 'keydown'];
  const onGesture = () => {
    void unlockAlertAudio().then(unlocked => {
      if (unlocked) events.forEach(event => window.removeEventListener(event, onGesture, true));
    });
  };
  events.forEach(event => window.addEventListener(event, onGesture, { capture: true, passive: true }));
}

function loadPreferences() {
  try { preferences = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (_) {}
  if (!['dark', 'light'].includes(preferences.theme)) preferences.theme = DEFAULT_PREFS.theme;
  if (!['car_horn', 'bell'].includes(preferences.tone)) preferences.tone = DEFAULT_PREFS.tone;
  if (!Number.isFinite(Number(preferences.volume))) preferences.volume = DEFAULT_PREFS.volume;
  if (!['0.9', '1', '1.1', '1.2'].includes(String(preferences.fontScale))) preferences.fontScale = DEFAULT_PREFS.fontScale;
  document.documentElement.style.setProperty('--font-scale', preferences.fontScale);
  document.body.dataset.theme = preferences.theme;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = preferences.theme === 'light' ? '#f7f8fa' : '#07080a';
  if ($('themeToggle')) $('themeToggle').textContent = preferences.theme === 'light' ? '☾' : '☼';
  if ($('arrivalTone')) $('arrivalTone').value = preferences.tone;
  if ($('volumeRange')) { $('volumeRange').value = preferences.volume; $('volumeValue').textContent = `${preferences.volume}%`; }
  if ($('fontScaleRange')) { $('fontScaleRange').value = preferences.fontScale; $('fontScaleValue').textContent = `${Math.round(Number(preferences.fontScale) * 100)}%`; }
}
function savePreferences() { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); }
function toggleTheme() { preferences.theme = preferences.theme === 'light' ? 'dark' : 'light'; savePreferences(); loadPreferences(); }
function operationalControlsHtml() {
  return `<div class="operational-panel" aria-label="Estado operativo"><div class="operational-panel-title">Estado operativo</div><div class="operational-panel-buttons">
    <button type="button" class="operational-panel-button" data-operational-status="available">Disponible</button>
    <button type="button" class="operational-panel-button" data-operational-status="unavailable">No disponible</button>
    <button type="button" class="operational-panel-button" data-operational-status="out_of_service">Fuera de servicio</button>
  </div></div>`;
}

/* ── Formatear tarifa ───────────────────────────────────────── */
function formatFare(t) {
  const v = t?.driver_fare ?? t?.fare;
  if (v == null || v === '') return null;
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(v));
}

function commercialFareValues(t) {
  const customerFare = t?.original_fare ?? t?.fare;
  if (customerFare == null || customerFare === '' || !Number.isFinite(Number(customerFare))) return null;
  const customer = Number(customerFare);
  let driver;
  // service_type_id is the commercial contract. Do not let a stale snapshot
  // combine a 15% label/amount with an Ahorro trip.
  if (String(t?.service_type_id) === '2') {
    driver = customer;
  } else if (t?.driver_fare != null) {
    driver = Number(t.driver_fare);
  } else if (t?.status === 'completed') {
    // Legacy completed trips must display their persisted historical amount.
    driver = Number(t?.fare ?? t?.original_fare);
  } else {
    driver = customer * 0.85;
  }
  if (!Number.isFinite(driver)) return null;
  return { customer, commission: customer - driver, driver };
}

function driverFareLabel(t) {
  if (String(t?.service_type_id) === '2') return 'Tarifa conductor (0% comisión)';
  if (t?.discount_percentage != null && Number.isFinite(Number(t.discount_percentage))) {
    return `Tarifa conductor (${Number(t.discount_percentage)}% comisión)`;
  }
  if (t?.service_type_id != null) return 'Tarifa conductor (15% comisión)';
  return 'Tarifa conductor';
}

function driverFareHtml(t) {
  const values = commercialFareValues(t);
  if (!values) return '';
  return `<div class="fare-row"><span class="fare-label">${driverFareLabel(t)}</span><span class="fare-value">${formatFare({ fare: values.driver })}</span></div>`;
}

function finalFareHtml(t) {
  const finalFare = t?.original_fare ?? t?.fare;
  if (finalFare == null || finalFare === '') return '';
  return `<div class="fare-row"><span class="fare-label">Tarifa cliente (100%)</span><span class="fare-value">${formatFare({ fare: finalFare })}</span></div>`;
}

function tripQueueHtml(current) {
  const pending = trips.filter(t => ['searching', 'assigned'].includes(t.status) && String(t.id) !== String(current?.id));
  if (!pending.length) return '';
  return `<section class="trip-queue" aria-label="Pedidos nuevos">
    <div class="trip-queue-heading">
      <div><div class="trip-queue-title">Otros pedidos recibidos</div><small>${pending.length} pendiente${pending.length === 1 ? '' : 's'}</small></div>
      <div class="trip-queue-tools">
        <button type="button" class="trip-queue-tool" data-trip-refresh>Actualizar</button>
        <button type="button" class="trip-queue-tool danger" data-trip-clear>Limpiar</button>
      </div>
    </div>
    ${pending.map(t => `<button type="button" class="trip-queue-item" data-trip-select="${esc(t.id)}">
      <span><strong>${esc(t.origin)}</strong><small>${esc(t.destination)}</small></span>
      <span class="trip-queue-arrow">Ver ›</span>
    </button>`).join('')}
  </section>`;
}

function bindTripQueue() {
  document.querySelectorAll('[data-trip-select]').forEach(button => {
    button.onclick = () => {
      const found = trips.find(t => String(t.id) === String(button.dataset.tripSelect));
      if (!found) return;
      selected = found;
      render();
    };
  });
  document.querySelectorAll('[data-trip-refresh]').forEach(button => {
    button.onclick = () => { button.disabled = true; loadTrips().finally(() => { button.disabled = false; }); };
  });
  document.querySelectorAll('[data-trip-clear]').forEach(button => {
    button.onclick = () => clearPendingTrips();
  });
}

function clearPendingTrips() {
  const pendingIds = trips
    .filter(t => ['searching', 'assigned'].includes(t.status) && String(t.id) !== String(selected?.id))
    .map(t => String(t.id));
  pendingIds.forEach(id => rememberRejectedTrip(id));
  trips = trips.filter(t => !pendingIds.includes(String(t.id)));
  if (selected && pendingIds.includes(String(selected.id))) selected = null;
  selectNextPendingTrip();
  showNotice(pendingIds.length ? 'Ofertas limpiadas de este dispositivo.' : 'No hay ofertas pendientes para limpiar.');
}

function selectNextPendingTrip() {
  const next = trips.find(t => ['searching', 'assigned'].includes(t.status));
  selected = next || null;
  render();
  return next;
}

function serviceTypeLabel(t) {
  if (t?.service_type_name) return t.service_type_name;
  return String(t?.service_type_id) === '1' ? 'Premium' : String(t?.service_type_id) === '2' ? 'Ahorro' : null;
}

// El API debe ordenar por fecha, pero la UI no depende del orden accidental
// en que el navegador resuelva o reciba una respuesta de polling.
function orderTripsNewestFirst(list) {
  return [...list].sort((a, b) => {
    const dateA = Date.parse(a?.created_at || '');
    const dateB = Date.parse(b?.created_at || '');
    if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateB - dateA;
    if (Number.isFinite(dateA) !== Number.isFinite(dateB)) return Number.isFinite(dateB) - Number.isFinite(dateA);
    const idA = Number(a?.id);
    const idB = Number(b?.id);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idB - idA;
    return 0;
  });
}

const DRIVER_CARD_STATUSES = ['searching', 'assigned', 'arriving', 'in_progress'];

function selectPrimaryTrip(list, current) {
  // Una solicitud nueva reemplaza solo otra solicitud pendiente. Si ya hay
  // un viaje aceptado/en curso, ese viaje sigue siendo la tarjeta principal.
  // Los viajes `searching` son ofertas globales. El primer conductor que
  // acepta hace el claim en el backend y pasa el viaje a `arriving`.
  // Siempre devolvemos la instancia recién recibida: conservar `current`
  // podía dejar origen/destino/status de una respuesta anterior en pantalla.
  const latestCurrent = current && list.find(t => String(t.id) === String(current.id));
  if (latestCurrent && ['arriving', 'in_progress'].includes(latestCurrent.status)) return latestCurrent;
  return list.find(t => ['searching', 'assigned'].includes(t.status)) || null;
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

  // Resolvemos qué viaje mostrar. Un viaje `searching` es una oferta global
  // que este conductor puede tomar; el backend hace el claim al aceptar.
  const t = selected && DRIVER_CARD_STATUSES.includes(selected.status)
    ? selected
    : trips.find(x => ['searching', 'assigned'].includes(x.status));

  const sheet  = $('sheet');
  const inner  = $('sheetInner');

  // ── Sin viaje ────────────────────────────────────────────── */
  if (!t) {
    sheet.className = 'sheet';
    inner.innerHTML = `
      ${operationalControlsHtml()}
      <div id="notice" class="notice hidden"></div>`;
    renderOperationalStatus();
    return;
  }

  selected = t;
  const st = t.status;

  // ── Viaje asignado (alerta) ──────────────────────────────── */
  if (st === 'assigned' || st === 'searching') {
    sheet.className = 'sheet alert-mode';
    inner.innerHTML = `
      ${operationalControlsHtml()}
      <div class="trip-alert">
        <div class="alert-badge">
          <span class="alert-pulse"></span>
          ${DEMO ? '🧪 DEMO — ' : ''}${st === 'searching' ? 'Nuevo viaje disponible' : 'Viaje recibido'}
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
        ${driverFareHtml(t)}

        <div class="alert-actions">
          <button class="btn-accept" onclick="acceptTrip()">✓ ACEPTAR</button>
          ${st === 'assigned'
            ? '<button class="btn-reject" onclick="rejectTrip()">✕ Rechazar</button>'
            : '<button class="btn-reject" onclick="dismissTrip()">✕ No aceptar</button>'}
        </div>
      </div>
      ${tripQueueHtml(t)}
      <div id="notice" class="notice hidden"></div>`;
    bindTripQueue();
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

      ${!isCompleted ? driverFareHtml(t) : ''}

      <div class="primary-actions">${primaryBtn}</div>

      ${isCompleted ? `<div class="final-fare-card">${finalFareHtml(t)}</div>` : ''}

      ${tripQueueHtml(t)}
    </div>
    ${operationalControlsHtml()}
    <div id="notice" class="notice hidden"></div>`;

  bindTripQueue();
}

/* ══════════════════════════════════════════════════════════════
   ACCIONES DE VIAJE
══════════════════════════════════════════════════════════════ */
async function acceptTrip() {
  const changed = await changeStatus('arriving');
  if (!changed) return;
  activeTripId = String(selected.id);
  startGps();
  await requestImmediateGpsSync();
  await loadTripRoute('pickup');
  speak('Viaje aceptado. Comenzando a compartir ubicación.');
}

function rememberRejectedTrip(id) {
  const rejectedId = String(id);
  rejectedTripIds.add(rejectedId);
  try {
    localStorage.setItem('livre_driver_rejected_trips', JSON.stringify([...rejectedTripIds]));
  } catch (e) {
    diagLog('rejected_trip_persistence_failed', { error: String(e?.message || e).slice(0, 80) });
  }
  return rejectedId;
}

async function rejectTrip() {
  if (!selected || !confirm('¿Rechazar este viaje?')) return;
  if (DEMO) {
    await changeStatus('cancelled');
    return;
  }
  try {
    const rejectedId = String(selected.id);
    const r = await fetch(`${API}/mobility/driver/trips/${selected.id}/reject`, {
      method: 'POST', headers: h(),
    });
    if (!r.ok) throw Error(r.status);
    await r.json();
    rememberRejectedTrip(rejectedId);
    trips = trips.filter(t => String(t.id) !== rejectedId);
    selectNextPendingTrip();
    showNotice('Rechazo registrado. El viaje queda disponible para otro conductor.');
  } catch (e) {
    showNotice('No se pudo registrar el rechazo.');
  }
}

function dismissTrip() {
  if (!selected) return;
  const dismissedId = rememberRejectedTrip(selected.id);
  trips = trips.filter(t => String(t.id) !== dismissedId);
  selected = null;
  selectNextPendingTrip();
  showNotice('Oferta ocultada en este dispositivo. Sigue disponible para otros conductores.');
}

async function nextStatus() {
  if (!selected) return;
  const next = { arriving: 'in_progress', in_progress: 'completed' }[selected.status];
  if (!next) return;
  const changed = await changeStatus(next);
  if (changed && next === 'in_progress') await loadTripRoute('trip');
  if (changed && next === 'completed') {
    activeTripId = null;
    clearTripRoute();
  }
}

/** Solo en DEMO: reinicia el viaje mock para poder recorrer el flujo de nuevo */
function demoReset() {
  DEMO_TRIP.status = 'assigned';
  selected = { ...DEMO_TRIP };
  trips = [selected];
  announcedTripIds.clear();
  render();
  announceNewTrip(selected);
}

/* ══════════════════════════════════════════════════════════════
   BACKEND CALLS — Hermes conecta estas funciones al API real
   En DEMO todas retornan inmediatamente sin tocar la red.
══════════════════════════════════════════════════════════════ */

/** Carga los viajes asignados al conductor */
function tripsPollingAllowed() {
  return !DEMO && !!token && !$('appView')?.classList.contains('hidden');
}

function stopTripsPolling() {
  tripsPollEpoch += 1;
  if (tripsPollTimer !== null) clearTimeout(tripsPollTimer);
  tripsPollTimer = null;
}

function scheduleTripsPolling(epoch) {
  if (epoch !== tripsPollEpoch || !tripsPollingAllowed()) return;
  tripsPollTimer = setTimeout(async () => {
    tripsPollTimer = null;
    if (epoch !== tripsPollEpoch || !tripsPollingAllowed()) return;
    try { await loadTrips(); }
    finally { scheduleTripsPolling(epoch); }
  }, TRIPS_POLL_MS);
}

function startTripsPolling() {
  stopTripsPolling();
  if (!tripsPollingAllowed()) return;
  const epoch = tripsPollEpoch;
  void loadTrips().finally(() => scheduleTripsPolling(epoch));
}

async function loadTrips() {
  // Nunca consultar viajes desde el login: sin token el API responde 401,
  // y logout() recarga la página, generando un ciclo de recargas.
  // DEMO no tiene JWT, pero debe renderizar el sheet igual que una sesión real.
  if ((!token && !DEMO) || $('appView')?.classList.contains('hidden')) return false;
  // En la APK actual el estado de visibilidad del WebView puede quedar
  // desfasado después de pausar/reanudar o reiniciar su renderer. El panel
  // visible es el criterio confiable para mantener la lista sincronizada.
  if (tripsRequestInFlight) return false;
  const startedAt = performance.now();
  let httpStatus = null;
  let result = 'error';
  let receivedCount = null;
  diagLog('trips_start');
  const requestEpoch = authEpoch;
  const requestToken = token;
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
    httpStatus = r.status;
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    const nextTrips = await r.json();
    receivedCount = Array.isArray(nextTrips) ? nextTrips.length : null;
    if (requestEpoch !== authEpoch || requestToken !== token) return false;
    trips = orderTripsNewestFirst(nextTrips.filter(t => !rejectedTripIds.has(String(t.id))));
    // La lista ya está ordenada por la fecha real del pedido. La tarjeta
    // principal toma el pendiente más nuevo; los anteriores quedan en la cola.
    selected = selectPrimaryTrip(trips, selected);
    // Los viajes terminales pertenecen al historial, no a la tarjeta operativa.
    // Si no queda otro viaje activo, render() debe mostrar solo el panel
    // operativo; conservarlo dejaba una ruta histórica visible sin sentido.
    if (!selected || selected.status === 'completed' || selected.status === 'cancelled')
      selected = trips.find(t => DRIVER_CARD_STATUSES.includes(t.status)) || null;
    render();
    applyCloudTripLocation(selected);
    // Anunciar cada ID nuevo evita que el primero silencie los siguientes.
    announcedTripIds.forEach(id => {
      if (!trips.some(t => String(t.id) === id && ['searching', 'assigned'].includes(t.status)))
        announcedTripIds.delete(id);
    });
    const freshTrips = trips.filter(t => ['searching', 'assigned'].includes(t.status) && !announcedTripIds.has(String(t.id)));
    if (!initialTripsLoaded) freshTrips.length = 0;
    freshTrips.forEach(announceNewTrip);
    initialTripsLoaded = true;
    resolvePendingNativeTrip();
    result = 'ok';
    return true;
  } catch(e) {
    diagLog('trips_error', { error: String(e?.name || e?.message || e).slice(0, 80) });
    showNotice('No se pudieron cargar los viajes. Revisá la conexión.');
    return false;
  } finally {
    clearTimeout(timeoutId);
    tripsRequestInFlight = false;
    diagLog('trips_end', {
      durationMs: Math.round(performance.now() - startedAt),
      httpStatus, result, receivedCount,
    });
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
  const startedAt = performance.now();
  diagLog('gps_position_received');
  setMapMarker(lat, lng);
  gpsState.provider = 'ACTIVE';
  gpsState.backend = 'SENDING';
  updateGpsPill();
  // ── DEMO ────────────────────────────────────────────────────
  if (DEMO) {
    gpsState.backend = 'SYNCED';
    updateGpsPill();
    diagLog('gps_send_end', { durationMs: Math.round(performance.now() - startedAt), endpoint: 'demo', result: 'ok' });
    return;
  }
  // ── REAL ────────────────────────────────────────────────────
  const body = JSON.stringify({ latitude: lat, longitude: lng, device_id: deviceId });
  try {
    const liveResponse = await fetch(`${API}/mobility/driver/location`, {
      method: 'POST', headers: h(), body,
    });
    diagLog('gps_send_response', { endpoint: 'driver', httpStatus: liveResponse.status });
    if (!liveResponse.ok) throw Error(`driver-location:${liveResponse.status}`);

    const gpsTrip = activeTripId
      ? trips.find(t => String(t.id) === activeTripId) || (selected && String(selected.id) === activeTripId ? selected : null)
      : (selected && tripUsesMapRoute(selected.status) ? selected : null);
    if (gpsTrip && tripUsesMapRoute(gpsTrip.status)) {
      const tripResponse = await fetch(`${API}/mobility/driver/trips/${gpsTrip.id}/location`, {
        method: 'POST', headers: h(), body,
      });
      diagLog('gps_send_response', { endpoint: 'trip', httpStatus: tripResponse.status });
      if (!tripResponse.ok) throw Error(`trip-location:${tripResponse.status}`);
    }
    if (gpsTrip && tripUsesMapRoute(gpsTrip.status)) scheduleRouteRefresh();
    gpsState.backend = 'SYNCED';
    updateGpsPill();
    diagLog('gps_send_end', { durationMs: Math.round(performance.now() - startedAt), result: 'ok' });
  } catch(e) {
    diagLog('gps_send_end', { durationMs: Math.round(performance.now() - startedAt), result: 'error', error: String(e?.message || e).slice(0, 80) });
    if (String(e?.message || '').includes('driver-location:401')) {
      try { window.AndroidGps?.clearSession?.(); } catch (_) {}
      clearWebSession();
      $('appView').classList.add('hidden');
      $('loginView').classList.remove('hidden');
      $('loginError').textContent = 'La sesión GPS expiró. Ingresá nuevamente.';
      $('loginError').classList.remove('hidden');
      return;
    }
    gpsState.backend = 'FAILED';
    updateGpsPill();
    showNotice('No se pudo enviar la ubicación GPS al backend.');
  }
}

// Fuerza una lectura puntual cuando cambia el estado operativo. El servicio
// nativo sigue enviando GPS en segundo plano; esto solo acelera la actualización.
function requestImmediateGpsSync() {
  if (DEMO || !token || !navigator.geolocation) return Promise.resolve(false);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => {
        void sendLocation(position.coords.latitude, position.coords.longitude).finally(() => resolve(true));
      },
      error => {
        diagLog('gps_status_sync_failed', { code: error?.code ?? null });
        resolve(false);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });
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
  diagLog('gps_recovery_start', { watcher: watchId !== null ? 'active' : 'missing' });
  if (gpsSuspended && watchId !== null) {
    navigator.geolocation?.clearWatch(watchId);
    watchId = null;
  }
  gpsSuspended = false;
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
  if (NATIVE_SHELL) {
    // The native service owns background GPS; WebView GPS keeps the foreground map marker live.
  }
  // ── REAL ────────────────────────────────────────────────────
  if (watchId !== null) { diagLog('gps_start_skipped', { reason: 'watcher_active' }); return; }
  diagLog('gps_start');
  gpsState.provider = 'STARTING';
  gpsState.backend = 'UNKNOWN';
  updateGpsPill();
  if (!navigator.geolocation) {
    showNotice('Este navegador no permite GPS. Habilitá la ubicación del navegador.');
    return;
  }
  requestGpsWakeLock();
  const opts = { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 };
  const onPos = p => {
    const lat = Number(p.coords.latitude);
    const lng = Number(p.coords.longitude);
    diagLog('gps_position_callback');
    recordOwnGpsPoint(lat, lng);
    sendLocation(lat, lng);
  };
  const onErr = e => {
    // Un timeout o una pérdida momentánea no significa que el proveedor
    // haya terminado. Mantener watchPosition activo permite recuperar el
    // primer fix y evita dejar el viaje aceptado sin marcador ni trazo.
    const code = e?.code ?? null;
    diagLog('gps_provider_lost', { code, error: String(e?.message || '').slice(0, 80) });
    gpsState.provider = 'LOST';
    updateGpsPill();
    if (code === 1) {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      showNotice('Permiso de GPS denegado. Habilitalo en el navegador y recargá.');
    }
  };
  navigator.geolocation.getCurrentPosition(onPos, onErr, opts);
  watchId = navigator.geolocation.watchPosition(onPos, onErr, opts);
  // watchPosition may not emit anything while the driver is stationary. Keep
  // the CRM session alive by sending the current position periodically too.
  if (!gpsHeartbeatTimer) {
    gpsHeartbeatTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.geolocation || !token) return;
      navigator.geolocation.getCurrentPosition(onPos, onErr, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000,
      });
    }, GPS_HEARTBEAT_MS);
  }
  if (!gpsRecoveryTimer) {
    gpsRecoveryTimer = setInterval(() => {
      if (document.visibilityState === 'visible') restartGpsAfterBackground();
    }, 10000);
  }
}

function stopGps() {
  if (DEMO) { gpsState.provider = 'STOPPED'; gpsState.backend = 'UNKNOWN'; updateGpsPill(); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (gpsHeartbeatTimer) clearInterval(gpsHeartbeatTimer);
  gpsHeartbeatTimer = null;
  if (gpsRecoveryTimer) clearInterval(gpsRecoveryTimer);
  gpsRecoveryTimer = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  gpsState.provider = 'STOPPED';
  gpsState.backend = 'UNKNOWN';
  diagLog('gps_stop');
  updateGpsPill();
}

function updateGpsPill() {
  const pill = $('gpsPill');
  const label = $('gpsLabel');
  if (!pill || !label) return;
  if (gpsState.provider === 'STARTING') {
    pill.className = 'gps-pill inactive';
    label.textContent = 'Solicitando GPS…';
  } else if (gpsState.provider === 'LOST') {
    pill.className = 'gps-pill inactive';
    label.textContent = 'GPS SIN SEÑAL';
  } else if (gpsState.provider === 'ACTIVE' && ['FAILED', 'UNKNOWN'].includes(gpsState.backend)) {
    pill.className = 'gps-pill';
    label.textContent = 'GPS activo · sin sincronizar';
  } else if (gpsState.provider === 'ACTIVE') {
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
async function loadTripTrace() {
  if (DEMO || !selected || !map || !tripUsesMapRoute(selected.status)) return false;
  try {
    const response = await fetch(`${API}/mobility/driver/trips/${selected.id}/trace?_=${Date.now()}`, {
      headers: h(), cache: 'no-store',
    });
    if (!response.ok) throw Error(response.status);
    const data = await response.json();
    const points = (data.points || [])
      .map(point => [Number(point.latitude), Number(point.longitude)])
      .filter(([lat, lng]) => pointIsInBahiaBlanca(lat, lng));
    if (points.length < 2) return false;
    ownTracePoints = points.slice(-1000);
    if (ownTraceLine) ownTraceLine.setLatLngs(ownTracePoints);
    else ownTraceLine = L.polyline(ownTracePoints, {
      color: '#facc15', weight: 6, opacity: 0.95,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);
    return true;
  } catch (error) {
    diagLog('gps_trace_load_failed', { error: String(error?.message || error).slice(0, 80) });
    return false;
  }
}

function clearTripRoute() {
  if (routeRefreshTimer) clearTimeout(routeRefreshTimer);
  routeRefreshTimer = null;
  if (routeLine && map) map.removeLayer(routeLine);
  routeLine = null;
}

function tripUsesMapRoute(status) {
  return ['assigned', 'accepted', 'arriving', 'started', 'in_progress'].includes(status);
}

function tripRoutePhase(status) {
  return ['started', 'in_progress'].includes(status) ? 'trip' : 'pickup';
}

function scheduleRouteRefresh() {
  if (routeRefreshTimer) clearTimeout(routeRefreshTimer);
  if (!selected || !tripUsesMapRoute(selected.status)) return;
  routeRefreshTimer = setTimeout(async () => {
    routeRefreshTimer = null;
    if (!selected || !tripUsesMapRoute(selected.status)) return;
    await loadTripRoute(tripRoutePhase(selected.status));
    scheduleRouteRefresh();
  }, 30000);
}

async function loadTripRoute(phase) {
  if (DEMO || !selected || !map) return false;
  try {
    const response = await fetch(`${API}/mobility/driver/trips/${selected.id}/route?phase=${phase}`, { headers: h() });
    if (!response.ok) throw Error(response.status);
    const route = await response.json();
    const points = (route.coordinates || []).map(([lng, lat]) => [lat, lng]);
    if (points.length < 2 || points.some(([lat, lng]) => !pointIsInBahiaBlanca(lat, lng))) throw Error('route-outside-bahia-blanca');
    clearTripRoute();
    routeLine = L.polyline(points, {
      color: '#38bdf8',
      weight: 6,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [28, 28], maxZoom: 16 });
    diagLog('trip_route_loaded', { phase, points: points.length });
    return true;
  } catch (error) {
    diagLog('trip_route_failed', { phase, status: String(error?.message || error).slice(0, 40) });
    showNotice('El viaje aceptó correctamente, pero todavía no se pudo trazar la ruta.');
    return false;
  }
}

function initMap() {
  map = L.map('map', { zoomControl: false, maxBounds: BAHIA_BLANCA_BOUNDS, maxBoundsViscosity: 0.85 })
          .setView([-38.718, -62.266], 14);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
  loadOtherDrivers();
  otherDriversTimer = setInterval(loadOtherDrivers, 15000);
  setTimeout(() => map?.invalidateSize(), 0);
}

function driverHeading(from, to) {
  const lat1 = from[0] * Math.PI / 180;
  const lat2 = to[0] * Math.PI / 180;
  const deltaLng = (to[1] - from[1]) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function driverHeadingIcon(heading) {
  return L.divIcon({
    className: 'driver-heading-icon',
    html: `<span style="transform: rotate(${heading + 90}deg)">➤</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function appendOwnTracePoint(lat, lng) {
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const point = [lat, lng];
  const last = ownTracePoints[ownTracePoints.length - 1];
  if (last && Math.abs(last[0] - lat) < 0.000001 && Math.abs(last[1] - lng) < 0.000001) return;
  ownTracePoints.push(point);
  if (ownTracePoints.length > 1000) ownTracePoints.shift();
  if (!ownTraceLine) {
    ownTraceLine = L.polyline(ownTracePoints, {
      color: '#facc15', weight: 6, opacity: 0.95,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);
  } else {
    ownTraceLine.setLatLngs(ownTracePoints);
  }
}

const BAHIA_BLANCA_BOUNDS = L.latLngBounds(
  [-38.90, -62.48],
  [-38.52, -62.05],
);

function pointIsInBahiaBlanca(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && BAHIA_BLANCA_BOUNDS.contains([lat, lng]);
}

function recordOwnGpsPoint(lat, lng) {
  if (!selected || !tripUsesMapRoute(selected.status)) return;
  const tripId = String(selected.id ?? '');
  if (!tripId || !pointIsInBahiaBlanca(lat, lng)) return;
  if (ownTraceTripId !== tripId) {
    ownTraceTripId = tripId;
    ownTracePoints = [];
    if (ownTraceLine && map) map.removeLayer(ownTraceLine);
    ownTraceLine = null;
  }
  appendOwnTracePoint(lat, lng);
}

function applyCloudTripLocation(trip) {
  const lat = Number(trip?.latitude);
  const lng = Number(trip?.longitude);
  if (!map || !pointIsInBahiaBlanca(lat, lng)) return false;
  setMapMarker(lat, lng);
  gpsState.provider = 'ACTIVE';
  updateGpsPill();
  return true;
}

function setMapMarker(lat, lng) {
  if (!map) return;
  const pos = [lat, lng];
  const heading = lastMapPosition ? driverHeading(lastMapPosition, pos) : 0;
  lastMapPosition = pos;
  if (!marker) {
    marker = L.circleMarker(pos, {
      radius: 10,
      fillColor: DRIVER_MARKER_COLORS[operationalStatus] || DRIVER_MARKER_COLORS.available,
      fillOpacity: 1,
      color: '#07080a',
      weight: 3,
    }).addTo(map);
  } else {
    marker.setLatLng(pos);
  }
  if (!directionMarker) {
    directionMarker = L.marker(pos, {
      icon: driverHeadingIcon(heading),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    directionMarker.setLatLng(pos);
    directionMarker.setIcon(driverHeadingIcon(heading));
  }
  map.setView(pos, Math.max(map.getZoom(), 15));
}

function updateOwnMarkerStyle() {
  if (!marker) return;
  marker.setStyle({ fillColor: DRIVER_MARKER_COLORS[operationalStatus] || DRIVER_MARKER_COLORS.available });
}

function tokenUserId() {
  const claims = tokenClaims();
  return String(claims.sub ?? claims.id ?? claims.user_id ?? '');
}

function tokenClaims() {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)));
  } catch (_) { return {}; }
}

function driverPopupHtml(driver, current = false) {
  const vehicle = driver?.vehicle || {};
  const trip = ['assigned', 'arriving', 'in_progress'].includes(driver?.tripStatus) ? 'En viaje' : 'Sin viaje';
  return `<div class="driver-popup ${current ? 'driver-popup-current' : ''}"><strong>${current ? 'Tu ubicación · ' : ''}${esc(driver?.driverName || 'Conductor')}</strong>
    <div><b>Vehículo:</b> ${esc(vehicle.model || 'No informado')}</div>
    <div><b>Patente:</b> ${esc(vehicle.plate || 'No informada')}</div>
    <div><b>Estado operativo:</b> ${esc(driver?.operationalLabel || 'No informado')}</div>
    <div><b>Estado de viaje:</b> ${trip}</div></div>`;
}

function otherDriverIcon() {
  return L.divIcon({
    className: '',
    html: '<span class="driver-other-marker"><span>•</span></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function isFreshDriverLocation(driver) {
  if (driver?.sessionActive === true) return true;
  if (driver?.sessionActive === false) return false;
  const timestamp = Date.parse(driver?.lastSee || '');
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 120000;
}

async function loadOtherDrivers() {
  if (!token || DEMO || !map || otherDriversRequestInFlight) return false;
  const requestEpoch = authEpoch;
  const requestToken = token;
  otherDriversRequestInFlight = true;
  try {
    const r = await fetch(`${API}/crm/operational?_=${Date.now()}`, { headers: h(), cache: 'no-store' });
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    const data = await r.json();
    if (requestEpoch !== authEpoch || requestToken !== token) return false;
    if (!otherDriversLayer) otherDriversLayer = L.layerGroup().addTo(map);
    otherDriversLayer.clearLayers();
    const drivers = Array.isArray(data.drivers) ? data.drivers : [];
    const ownId = String(currentDriverUserId || tokenUserId());
    const ownTripId = activeTripId || (selected && selected.id != null ? String(selected.id) : '');
    // Primero identifica por usuario; durante una sesión activa también puede
    // identificar al propio conductor por el viaje asignado a ese token.
    currentDriverSnapshot = drivers.find(driver =>
      ownId && String(driver.driverUserId) === ownId && driver.lastPlace
    ) || drivers.find(driver =>
      ownTripId && String(driver.tripId) === ownTripId && driver.lastPlace
    ) || null;
    const ownLocation = currentDriverSnapshot?.lastPlace;
    if (ownLocation && Number.isFinite(Number(ownLocation.latitude)) && Number.isFinite(Number(ownLocation.longitude))) {
      setMapMarker(Number(ownLocation.latitude), Number(ownLocation.longitude));
      gpsState.provider = 'ACTIVE';
      updateGpsPill();
    }

    if (marker && currentDriverSnapshot) marker.bindPopup(driverPopupHtml(currentDriverSnapshot, true));
    if (selected && tripUsesMapRoute(selected.status)) {
      void loadTripRoute(tripRoutePhase(selected.status));
      void loadTripTrace();
    }
    const icon = otherDriverIcon();
    drivers.forEach(driver => {
      if (!isFreshDriverLocation(driver) || !driver.lastPlace) return;
      if (ownId && String(driver.driverUserId) === ownId) return;
      const lat = Number(driver.lastPlace?.latitude);
      const lng = Number(driver.lastPlace?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      L.marker([lat, lng], { icon, keyboard: false })
        .bindPopup(driverPopupHtml(driver))
        .addTo(otherDriversLayer);
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    otherDriversRequestInFlight = false;
  }
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICACIÓN DE VIAJE NUEVO
══════════════════════════════════════════════════════════════ */
function announceNewTrip(t) {
  if (operationalStatus === 'out_of_service' || !t) {
    diagLog('trip_announce_skipped', { reason: !t ? 'empty' : 'out_of_service' });
    return;
  }
  const id = t.id != null ? String(t.id) : '';
  if (!id || announcedTripIds.has(id)) {
    diagLog('trip_announce_skipped', { reason: !id ? 'missing_id' : 'already_announced' });
    return;
  }
  diagLog('trip_announce_start');
  announcedTripIds.add(id);
  showNotice(`Nuevo viaje disponible: ${t.origin || 'origen'} → ${t.destination || 'destino'}`);
  const fallback = () => window.AndroidGps?.notifyTripFallback?.(
    id, t.origin || '', t.destination || '', preferences.tone);
  if (document.visibilityState === 'visible') {
    beep().then(played => { if (!played) fallback(); });
    speak(`Nuevo viaje disponible. Origen: ${t.origin}. Destino: ${t.destination}.`);
  } else {
    fallback();
  }
  diagLog('trip_announce_end', { mode: document.visibilityState === 'visible' ? 'foreground' : 'background' });
}

function renderOperationalStatus() {
  document.querySelectorAll('[data-operational-status]').forEach(item => {
    item.classList.toggle('selected', item.dataset.operationalStatus === operationalStatus);
    item.onclick = async () => await changeOperationalStatus(item.dataset.operationalStatus);
  });
}

async function loadOperationalStatus() {
  if (!token || DEMO) { renderOperationalStatus(); return true; }
  const requestEpoch = authEpoch;
  const requestToken = token;
  try {
    const r = await fetch(`${API}/mobility/driver/operational-status`, { headers: h(), cache: 'no-store' });
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    const data = await r.json();
    if (requestEpoch !== authEpoch || requestToken !== token) return false;
    if (!OPERATIONAL_STATUS_LABELS[data.status]) throw Error('invalid-status');
    operationalStatus = data.status;
    updateOwnMarkerStyle();
    renderOperationalStatus();
    return true;
  } catch (e) {
    showNotice('No se pudo sincronizar tu estado operativo.');
    return false;
  }
}

async function changeOperationalStatus(status) {
  if (!OPERATIONAL_STATUS_LABELS[status]) return false;
  if (DEMO) { operationalStatus = status; renderOperationalStatus(); return true; }
  try {
    const r = await fetch(`${API}/mobility/driver/operational-status`, {
      method: 'PUT', headers: h(), body: JSON.stringify({ status }),
    });
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    const data = await r.json();
    if (!OPERATIONAL_STATUS_LABELS[data.status]) throw Error('invalid-status');
    operationalStatus = data.status;
    updateOwnMarkerStyle();
    renderOperationalStatus();
    await requestImmediateGpsSync();
    await loadTrips();
    return true;
  } catch (e) {
    showNotice('No se pudo actualizar tu estado operativo.');
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   HISTORIAL, RECAUDACIÓN Y CIERRE DIARIO
══════════════════════════════════════════════════════════════ */
const money = value => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(value || 0));
const knownAmount = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const displayMoney = value => value == null ? 'No informado' : money(value);
function historyTotals(data = {}) {
  return {
    trips: data.total ?? data.trip_count ?? null,
    billed: knownAmount(data.total_revenue ?? data.total_billed),
    driver: knownAmount(data.driver_revenue ?? data.total_driver_revenue ?? data.driver_amount),
    commission: knownAmount(data.commission ?? data.total_commission ?? data.commission_amount),
  };
}
function historyTotalsHtml(data, title = '') {
  const totals = historyTotals(data);
  return `${title ? `<h3 class="history-section-title">${title}</h3>` : ''}
    <div class="history-summary" aria-label="Resumen económico del día">
      <div class="history-stat"><small>Viajes realizados</small><strong>${totals.trips == null ? 'No informado' : totals.trips}</strong></div>
      <div class="history-stat"><small>Total facturado</small><strong>${displayMoney(totals.billed)}</strong></div>
      <div class="history-stat"><small>Importe del conductor</small><strong>${displayMoney(totals.driver)}</strong></div>
      <div class="history-stat"><small>Comisiones</small><strong>${displayMoney(totals.commission)}</strong></div>
    </div>`;
}
function localDateInput() { return new Date().toLocaleDateString('en-CA'); }
function historyNotice(message) {
  const el = $('historyNotice');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}
function renderHistory(data) {
  $('historySummary').innerHTML = historyTotalsHtml(data);
  $('historyList').innerHTML = data.items?.length
    ? data.items.map(item => `<div class="history-item"><strong>${esc(item.origin)} → ${esc(item.destination)}</strong><br><span>${esc(item.status)} · ${esc(item.completed_at ? new Date(item.completed_at).toLocaleString('es-AR') : 'Sin fecha')}</span><br><b>${money(item.fare)}</b></div>`).join('')
    : '<div class="history-item"><span>No hay viajes finalizados en el período.</span></div>';
  $('historyClosure').innerHTML = `<button id="closeShiftButton" class="settings-preview" type="button">Finalizar turno y guardar cierre</button>`;
  $('closeShiftButton').onclick = closeDriverShift;
}
async function loadDriverHistory() {
  if (!token || DEMO) {
    renderHistory({ total: DEMO ? 1 : 0, total_revenue: DEMO ? DEMO_TRIP.fare : 0, items: DEMO ? [{ ...DEMO_TRIP, origin: DEMO_TRIP.origin, destination: DEMO_TRIP.destination, completed_at: new Date().toISOString(), status: 'completed' }] : [] });
    return true;
  }
  const from = $('historyFrom').value;
  const to = $('historyTo').value;
  historyNotice('Cargando…');
  try {
    const r = await fetch(`${API}/mobility/driver/history?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, { headers: h(), cache: 'no-store' });
    if (r.status === 401) { logout(); return false; }
    if (!r.ok) throw Error(r.status);
    renderHistory(await r.json());
    historyNotice('');
    await loadDriverClosures();
    return true;
  } catch (_) {
    historyNotice('No se pudo cargar el historial. Revisá la conexión.');
    return false;
  }
}
async function loadDriverClosures() {
  if (!token || DEMO) return;
  try {
    const r = await fetch(`${API}/mobility/driver/shift-closures`, { headers: h(), cache: 'no-store' });
    if (!r.ok) return;
    const closures = await r.json();
    if (!closures.length) return;
    $('historyClosure').insertAdjacentHTML('beforeend', `<div class="history-item"><strong>Cierres guardados</strong><br>${closures.slice(0, 5).map(c => `${esc(c.closure_date)} · ${c.trip_count} viajes · ${money(c.total_revenue)} <button class="settings-preview" type="button" data-pdf-id="${esc(c.id)}">PDF</button>`).join('<br>')}</div>`);
    document.querySelectorAll('[data-pdf-id]').forEach(button => { button.onclick = () => downloadShiftPdf(button.dataset.pdfId); });
  } catch (_) {}
}
async function closeDriverShift() {
  const closureDate = $('historyTo').value || localDateInput();
  if (!confirm(`¿Confirmar el cierre del turno del ${closureDate}?`)) return false;
  if (DEMO) { historyNotice('Cierre demo no persistido.'); return false; }
  try {
    const r = await fetch(`${API}/mobility/driver/shift-closures`, { method: 'POST', headers: h(), body: JSON.stringify({ closure_date: closureDate }) });
    const data = await r.json();
    if (r.status === 409) { historyNotice('Este turno ya está cerrado.'); await loadDriverClosures(); return false; }
    if (!r.ok) throw Error(data.detail || r.status);
    $('historyClosure').innerHTML = `<div class="history-item"><strong>Turno cerrado</strong>${historyTotalsHtml({ ...data, total: data.trip_count }, 'Resumen final del día')}<button id="downloadNewPdf" class="settings-preview" type="button">Descargar / compartir PDF</button></div>`;
    $('downloadNewPdf').onclick = () => downloadShiftPdf(data.id);
    historyNotice('Cierre guardado en Livre.');
    return true;
  } catch (_) {
    historyNotice('No se pudo guardar el cierre. Revisá la conexión.');
    return false;
  }
}
async function downloadShiftPdf(closureId) {
  try {
    const r = await fetch(`${API}/mobility/driver/shift-closures/${encodeURIComponent(closureId)}/pdf`, { headers: h(), cache: 'no-store' });
    if (!r.ok) throw Error(r.status);
    const blob = await r.blob();
    if (blob.type !== 'application/pdf') throw Error('invalid-pdf');
    const file = new File([blob], `livre-cierre-${closureId}.pdf`, { type: 'application/pdf' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: 'Resumen diario Livre', files: [file] });
      return true;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (_) {
    historyNotice('No se pudo generar o compartir el PDF.');
    return false;
  }
}
function openHistory() {
  $('historyModal').classList.remove('hidden');
  const today = localDateInput();
  if (!$('historyFrom').value) $('historyFrom').value = today;
  if (!$('historyTo').value) $('historyTo').value = today;
  loadDriverHistory();
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

window.onNativeLocationStatus = (status, latitude, longitude) => {
  if (!NATIVE_SHELL || !token) return;
  if (status === 'updated' && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    lastNativeLocationAt = Date.now();
    setMapMarker(latitude, longitude);
    recordOwnGpsPoint(latitude, longitude);
    gpsState.provider = 'ACTIVE';
    updateGpsPill();
  } else if (status === 'provider_lost' || status === 'provider_stopped') {
    // Native FGS can briefly report a provider transition while its fused
    // request is being recreated. Do not overwrite a recent valid fix.
    if (!lastNativeLocationAt || Date.now() - lastNativeLocationAt > 45000)
      gpsState.provider = 'LOST';
    updateGpsPill();
  }
};

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
  unlockAlertAudio();
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
    const body = { username: user, password: pass, device_id: deviceId };
    if (reg) body.name = $('nameInput').value.trim();
    const endpoint = reg ? '/auth/driver/register' : '/auth/driver/login';
    const r    = await fetch(API + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw Error(data.detail || 'No se pudo completar la operación');
    token = data.token;
    authEpoch += 1;

    localStorage.setItem('livre_driver_token', token);
    openApp();
  } catch(err) {
    $('loginError').textContent = err.message || 'Error de conexión';
    $('loginError').classList.remove('hidden');
  }
}

function startNativeBackgroundLocation() {
  if (DEMO || !token || !window.AndroidGps) return;
  try {
    window.AndroidGps.startLocation(token, API);
    updateGpsPill(true);
  } catch (e) { console.warn('native GPS unavailable', e); }
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

function openApp() {
  const claims = tokenClaims();
  currentDriverUserId = String(claims.sub || '');
  ownTracePoints = [];
  if (ownTraceLine && map) map.removeLayer(ownTraceLine);
  ownTraceLine = null;
  // snapshot del conductor actual.
  trips = [];
  selected = null;
  initialTripsLoaded = false;
  announcedTripIds.clear();

  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  // La sesión nueva no debe mostrar la tarjeta de la identidad anterior
  // mientras llega el primer snapshot del conductor actual.
  render();
  $('sheetInner').scrollTop = 0;
  initMap();
  startNativeBackgroundLocation();
  startGps();
  loadOperationalStatus().then(() => startTripsPolling());
}

function clearWebSession() {
  // El JWT es la única credencial web persistida. También limpiamos la sesión
  // de la pestaña para no dejar estado de autenticación en un WebView.
  token = null;
  activeTripId = null;
  authEpoch += 1;
  currentDriverUserId = '';
  currentDriverSnapshot = null;
  trips = [];
  selected = null;
  initialTripsLoaded = false;
  announcedTripIds.clear();
  DEMO = false;
  try {
    localStorage.removeItem('livre_driver_token');
    sessionStorage.clear();
  } catch (e) {}
}

async function logout() {
  stopTripsPolling();
  stopGps();
  stopNativeBackgroundLocation();
  const sessionToken = token;
  if (sessionToken && !DEMO) {
    try {
      await fetch(`${API}/mobility/driver/location`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'X-Device-ID': deviceId },
        keepalive: true,
      });
    } catch (_) {}
  }
  if (window.AndroidGps?.clearSession) {
    try { window.AndroidGps.clearSession(); } catch (e) {}
  }
  clearWebSession();
  location.reload();
}

/* ── Bootstrap ──────────────────────────────────────────────── */
loadPreferences();
installAudioGestureUnlock();
$('loginForm').onsubmit = login;
$('toggleAuth').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('logoutBtn').onclick = logout;
$('themeToggle').onclick = toggleTheme;
$('historyButton').onclick = openHistory;
$('historyClose').onclick = () => $('historyModal').classList.add('hidden');
$('historyRefresh').onclick = loadDriverHistory;
$('historyModal').onclick = e => { if (e.target.id === 'historyModal') $('historyModal').classList.add('hidden'); };
$('settingsButton').onclick = () => $('settingsModal').classList.remove('hidden');
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsModal').onclick = e => { if (e.target.id === 'settingsModal') $('settingsModal').classList.add('hidden'); };
$('tonePreview').onclick = () => { unlockAlertAudio(); beep(); };
$('arrivalTone').onchange = e => { preferences.tone = e.target.value; alertAudioUnlocked = false; alertAudioUnlockPromise = null; alertAudio = null; savePreferences(); void unlockAlertAudio(); };
$('volumeRange').oninput = e => { preferences.volume = Number(e.target.value); if (alertAudio) alertAudio.volume = preferences.volume / 100; $('volumeValue').textContent = `${preferences.volume}%`; savePreferences(); };
$('fontScaleRange').oninput = e => { preferences.fontScale = Number(e.target.value); $('fontScaleValue').textContent = `${Math.round(preferences.fontScale * 100)}%`; savePreferences(); loadPreferences(); };

document.addEventListener('visibilitychange', () => {
  setNativeAppVisible(document.visibilityState === 'visible');
  if (document.visibilityState === 'visible') {
    restartGpsAfterBackground();
    startTripsPolling();
  } else gpsSuspended = true;
});
window.addEventListener('pageshow', () => {
  restartGpsAfterBackground();
  startTripsPolling();
});
window.addEventListener('focus', () => {
  restartGpsAfterBackground();
  startTripsPolling();
});
window.addEventListener('online', () => {
  restartGpsAfterBackground();
  startTripsPolling();
});

if (token) openApp();
