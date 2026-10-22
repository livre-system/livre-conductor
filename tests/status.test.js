const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync('js/app.js', 'utf8');
const nativeSource = fs.readFileSync('android/app/src/main/java/com/livre/conductor/MainActivity.java', 'utf8');
const sessionStoreSource = fs.readFileSync('android/app/src/main/java/com/livre/conductor/SessionStore.java', 'utf8');

describe('driver operational status synchronization', () => {
  it('fetches the backend status before rendering the control', () => {
    assert.match(source, /async function loadOperationalStatus\(\)/);
    assert.match(source, /fetch\(`\$\{API\}\/mobility\/driver\/operational-status`/);
  });

  it('sends status changes to the backend and uses its response', () => {
    assert.match(source, /async function changeOperationalStatus\(status\)/);
    assert.match(source, /method: 'PUT'/);
    assert.match(source, /operationalStatus = data\.status/);
  });

  it('uses the same v2 trip notification channel as the native service', () => {
    assert.match(nativeSource, /TRIPS_NOTIFICATION_CHANNEL\s*=\s*"livre_trips_v2"/);
    assert.match(fs.readFileSync('android/app/src/main/java/com/livre/conductor/PermissionGate.java', 'utf8'), /getNotificationChannel\("livre_trips_v2"\)/);
    assert.match(fs.readFileSync('android/app/src/main/java/com/livre/conductor/LocationService.java', 'utf8'), /TRIP_CHANNEL\s*=\s*"livre_trips_v2"/);
  });

  it('keeps GPS startup independent from operational status', () => {
    assert.match(source, /startGps\(\);/);
    assert.match(source, /loadOperationalStatus\(\)\.then\(\(\) => startTripsPolling\(\)\)/);
    assert.doesNotMatch(source, /operationalStatus\s*===\s*['"]out_of_service['"][\s\S]{0,120}stopGps\(/);
  });

  it('only suppresses new-trip announcements while preserving assigned trips', () => {
    assert.match(source, /function announceNewTrip\(t\)/);
    assert.match(source, /operationalStatus === 'out_of_service' \|\| !t/);
    assert.match(source, /function selectPrimaryTrip\(list, current\)/);
    assert.match(source, /return list\.find\(t => t\.status === 'assigned'\) \|\| null/);
    assert.match(source, /selected\.status === 'completed' \|\| selected\.status === 'cancelled'/);
  });

  it('does not leave a terminal or searching trip card when no driver trip remains', () => {
    assert.match(source, /const DRIVER_CARD_STATUSES = \['assigned', 'arriving', 'in_progress'\]/);
    assert.match(source, /selected = trips\.find\(t => DRIVER_CARD_STATUSES\.includes\(t\.status\)\) \|\| null/);
    assert.match(source, /selected && DRIVER_CARD_STATUSES\.includes\(selected\.status\)/);
  });

  it('does not reuse a terminal selection from the previous polling response', () => {
    assert.match(source, /if \(latestCurrent && \['arriving', 'in_progress'\]\.includes\(latestCurrent\.status\)\)/);
    assert.match(source, /return list\.find\(t => t\.status === 'assigned'\) \|\| null/);
  });

  it('clears the previous driver card before loading the new session snapshot', () => {
    assert.match(source, /\$\('appView'\)\.classList\.remove\('hidden'\);[\s\S]{0,180}render\(\);[\s\S]{0,100}\$\('sheetInner'\)\.scrollTop = 0;[\s\S]{0,80}initMap\(\);/);
  });

  it('shows net driver fare while a trip is active and gross fare when completed', () => {
    assert.match(source, /function driverFareHtml\(t\)/);
    assert.match(source, /!isCompleted \? driverFareHtml\(t\) : ''/);
    assert.match(source, /function finalFareHtml\(t\)/);
    assert.match(source, /const finalFare = t\?\.original_fare \?\? t\?\.fare/);
    assert.match(source, /final-fare-card/);

    const fareSource = source.slice(source.indexOf('function formatFare'), source.indexOf('function serviceTypeLabel'));
    const context = { Intl };
    require('vm').runInNewContext(`${fareSource}; this.driverFareHtml = driverFareHtml; this.finalFareHtml = finalFareHtml;`, context);
    assert.match(context.driverFareHtml({ fare: 4800 }), /4\.080/);
    assert.match(context.driverFareHtml({ fare: 4800, final_fare: 4000 }), /4\.080/);
    assert.match(context.driverFareHtml({ fare: 4800, service_type_id: '2' }), /4\.800/);
    assert.match(context.driverFareHtml({ fare: 4800, service_type_id: '2' }), /0% comisión/);
    assert.match(context.driverFareHtml({ fare: 5054, original_fare: 5054, service_type_id: '2', driver_fare: 4295.9, discount_percentage: 15, final_fare: 4295.9 }), /5\.054/);
    assert.match(context.driverFareHtml({ fare: 5054, original_fare: 5054, service_type_id: '2', driver_fare: 4295.9, discount_percentage: 15, final_fare: 4295.9 }), /0% comisión/);
    assert.doesNotMatch(context.driverFareHtml({ fare: 5054, original_fare: 5054, service_type_id: '2', driver_fare: 4295.9, discount_percentage: 15, final_fare: 4295.9 }), /15% comisión/);
    assert.match(context.driverFareHtml({ fare: 4800, service_type_id: '1' }), /15% comisión/);
    assert.match(context.driverFareHtml({ fare: 4800, status: 'completed', original_fare: 4800 }), /4\.800/);
    assert.doesNotMatch(source, /btnHandy|btnVoice|Handy|Libi/);
    assert.match(context.finalFareHtml({ fare: 4800, final_fare: 4000 }), /4\.800/);
  });

  it('renders every assigned trip while another trip is selected', () => {
    assert.match(source, /function tripQueueHtml\(current\)/);
    assert.match(source, /data-trip-select=/);
    assert.match(source, /function bindTripQueue\(\)/);
    assert.match(source, /trips\.filter\(t => t\.status === 'assigned'/);
    assert.match(source, /selected = found;/);
  });

  it('promotes the newest assigned trip without dropping older queue items', () => {
    assert.match(source, /function orderTripsNewestFirst\(list\)/);
    assert.match(source, /function selectPrimaryTrip\(list, current\)/);
    assert.match(source, /trips = orderTripsNewestFirst\(nextTrips\.filter/);
    assert.match(source, /selected = selectPrimaryTrip\(trips, selected\)/);
    assert.match(source, /trips\.filter\(t => t\.status === 'assigned' && String\(t\.id\) !== String\(current\?\.id\)/);

    const start = source.indexOf('function orderTripsNewestFirst');
    const end = source.indexOf('/* ═', start);
    const context = {};
    require('vm').runInNewContext(`${source.slice(start, end)}; this.orderTripsNewestFirst = orderTripsNewestFirst; this.selectPrimaryTrip = selectPrimaryTrip;`, context);
    const older = { id: 10, status: 'assigned', created_at: '2026-10-19T10:00:00Z' };
    const newest = { id: 11, status: 'assigned', created_at: '2026-10-19T10:01:00Z' };
    const ordered = context.orderTripsNewestFirst([older, newest]);
    assert.deepStrictEqual(Array.from(ordered, t => t.id), [11, 10]);
    assert.strictEqual(context.selectPrimaryTrip(ordered, older), newest);
    assert.deepStrictEqual(Array.from(ordered, t => t.id), [11, 10]);
  });

  it('does not replace an active trip when a new pending trip arrives', () => {
    assert.match(source, /\['arriving', 'in_progress'\]\.includes\(latestCurrent\.status\)/);
    const start = source.indexOf('function orderTripsNewestFirst');
    const end = source.indexOf('/* ═', start);
    const context = {};
    require('vm').runInNewContext(`${source.slice(start, end)}; this.selectPrimaryTrip = selectPrimaryTrip;`, context);
    const active = { id: 10, status: 'arriving', origin: 'Origen anterior' };
    const latestActive = { id: 10, status: 'arriving', origin: 'Origen actualizado' };
    const pending = { id: 11, status: 'assigned', created_at: '2026-10-19T10:01:00Z' };
    assert.strictEqual(context.selectPrimaryTrip([pending, latestActive], active), latestActive);
    assert.strictEqual(context.selectPrimaryTrip([pending, latestActive], active).origin, 'Origen actualizado');
  });

  it('clears the previous session card before loading the new driver snapshot', () => {
    assert.match(source, /function openApp\(\)[\s\S]*?trips = \[\];[\s\S]*?selected = null;[\s\S]*?initialTripsLoaded = false;/);
  });

  it('clears the selected trip when the backend returns no current trips', () => {
    const start = source.indexOf('function orderTripsNewestFirst');
    const end = source.indexOf('/* ═', start);
    const context = {};
    require('vm').runInNewContext(`${source.slice(start, end)}; this.selectPrimaryTrip = selectPrimaryTrip;`, context);
    const active = { id: 10, status: 'in_progress' };
    assert.strictEqual(context.selectPrimaryTrip([], active), null);
  });

  it('moves to the next pending trip after resolving only the selected rejection', () => {
    assert.match(source, /function selectNextPendingTrip\(\)/);
    assert.match(source, /const next = trips\.find\(t => t\.status === 'assigned'\)/);
    assert.match(source, /rememberRejectedTrip\(rejectedId\)/);
    assert.match(source, /trips = trips\.filter\(t => String\(t\.id\) !== rejectedId\)/);
    assert.match(source, /selectNextPendingTrip\(\);/);
  });

  it('keeps the UI rejection independent from localStorage failures', () => {
    assert.match(source, /function rememberRejectedTrip\(id\)/);
    const start = source.indexOf('function rememberRejectedTrip');
    const end = source.indexOf('async function rejectTrip', start);
    const context = {
      rejectedTripIds: new Set(),
      localStorage: { setItem() { throw Error('quota'); } },
      diagLog() {},
    };
    require('vm').runInNewContext(`${source.slice(start, end)}; this.rememberRejectedTrip = rememberRejectedTrip;`, context);
    assert.strictEqual(context.rememberRejectedTrip(187), '187');
    assert.ok(context.rejectedTripIds.has('187'));
  });

  it('keeps a rejected trip available to other drivers without passenger messaging', () => {
    const router = fs.readFileSync('../livre-cloud/app/mobility/router.py', 'utf8');
    assert.match(router, /SET status = 'searching'/);
    assert.match(router, /assigned_driver_user_id = NULL/);
    assert.doesNotMatch(router, /send_rejection_message\(rejected_trip\)/);
  });

  it('announces each newly assigned trip, including when an older trip stays open', () => {
    assert.match(source, /const freshTrips = trips\.filter\(t => t\.status === 'assigned'/);
    assert.match(source, /freshTrips\.forEach\(announceNewTrip\)/);
    assert.match(source, /showNotice\(`Nuevo viaje disponible/);
  });

  it('renders demo trips without requiring a JWT token', () => {
    assert.match(source, /if \(\(!token && !DEMO\) \|\|/);
    assert.match(source, /if \(DEMO\) \{[\s\S]*?trips\s*=\s*\[\{ \.\.\.DEMO_TRIP \}\]/);
  });

  it('uses the CRM operational snapshot for peer locations', () => {
    assert.match(source, /fetch\(`\$\{API\}\/crm\/operational\?_=/);
    assert.match(source, /driver\.lastPlace\?\.latitude/);
    assert.match(source, /otherDriversTimer = setInterval\(loadOtherDrivers, 15000\)/);
  });

  it('selects MP3 when the browser cannot decode Ogg/Vorbis', () => {
    const start = source.indexOf('const TONE_SOURCES');
    const end = source.indexOf('function loadPreferences', start);
    const context = {
      preferences: { tone: 'car_horn', volume: 70 },
      document: { createElement: () => ({ canPlayType: mime => mime === 'audio/mpeg' ? 'probably' : '' }) },
    };
    require('vm').runInNewContext(`${source.slice(start, end)}; this.supportedToneSource = supportedToneSource;`, context);
    assert.strictEqual(context.supportedToneSource(), 'assets/audio/car-horn.mp3');
  });

  it('attempts audio unlock from a real user gesture and records blocked playback', () => {
    assert.match(source, /function installAudioGestureUnlock\(\)/);
    assert.match(source, /pointerdown.*touchstart.*keydown/);
    assert.match(source, /alert_audio_unlock_failed/);
    assert.match(source, /alert_audio_play_failed/);
  });

  it('keeps a visible fallback when browser autoplay remains blocked', () => {
    assert.match(source, /beep\(\)\.then\(played => \{ if \(!played\) fallback\(\); \}\)/);
    assert.match(source, /notifyTripFallback/);
    assert.match(source, /document\.visibilityState === 'visible'/);
  });

  it('uses real CRM driver fields in marker popups', () => {
    assert.match(source, /driver\?\.driverName/);
    assert.match(source, /vehicle\.model/);
    assert.match(source, /vehicle\.plate/);
    assert.match(source, /Estado de viaje/);
    assert.ok(!source.includes('<strong>Conductor Livre</strong>'));
  });

  it('provides persistent theme and driver preferences', () => {
    assert.match(source, /PREFS_KEY = 'livre_driver_preferences'/);
    assert.match(source, /localStorage\.setItem\(PREFS_KEY/);
    assert.match(source, /tonePreview/);
    assert.match(source, /fontScaleRange/);
  });

  it('clears web authentication state before reloading after logout', () => {
    assert.match(source, /function clearWebSession\(\)/);
    assert.match(source, /token = null/);
    assert.match(source, /localStorage\.removeItem\('livre_driver_token'\)/);
    assert.match(source, /sessionStorage\.clear\(\)/);
    assert.match(source, /clearWebSession\(\);[\s\S]*location\.reload\(\)/);
    assert.match(source, /method: 'DELETE'/);
    assert.match(source, /\/mobility\/driver\/location/);
  });

  it('clears the native session synchronously without bridge recursion', () => {
    assert.match(nativeSource, /SessionStore\.clear\(MainActivity\.this\);[\s\S]*MainActivity\.this\.clearSession\(\)/);
    assert.match(sessionStoreSource, /remove\(TOKEN\)[\s\S]*remove\(API\)[\s\S]*commit\(\)/);
    assert.doesNotMatch(nativeSource, /runOnUiThread\(\(\) => clearSession\(\)\)/);
  });

  it('derives the active driver identity from the new JWT, not the login response cache', () => {
    assert.match(source, /function tokenClaims\(\)/);
    assert.match(source, /const claims = tokenClaims\(\);/);
    assert.match(source, /currentDriverUserId = String\(claims\.sub \|\| ''\)/);
  });

  it('prevents stale web requests and native GPS work from crossing sessions', () => {
    assert.match(source, /let authEpoch\s*=\s*0;/);
    assert.match(source, /let gpsSendControllers = new Set\(\);/);
    assert.match(source, /function sendLocation\(lat, lng, accuracy = null, sessionEpoch = authEpoch\)/);
    assert.match(source, /sessionEpoch !== authEpoch \|\| !token/);
    assert.match(source, /controller\.abort\(\)/);
    assert.match(source, /sendLocation\(lat, lng, p\.coords\.accuracy, gpsEpoch\)/);
    assert.match(source, /const PENDING_GPS_KEY = 'livre_driver_pending_gps';/);
    assert.match(source, /function queuePendingGpsLocation\(/);
    assert.match(source, /function flushPendingGpsLocation\(/);
    assert.match(source, /window\.addEventListener\('online', \(\) => \{/);
    assert.match(source, /flushPendingGpsLocation\(\);/);
    assert.match(source, /localStorage\.removeItem\(PENDING_GPS_KEY\)/);
    assert.match(source, /const requestEpoch = authEpoch;/);
    assert.match(source, /requestEpoch !== authEpoch/);
    assert.match(nativeSource, /SessionStore\.save\(MainActivity\.this, token, api\)/);
    assert.match(nativeSource, /JavascriptInterface public String getDeviceId\(\)/);
    assert.match(source, /window\.AndroidGps\.getDeviceId\?\.\(\)/);
    assert.match(source, /window\.AndroidGps\.startLocation\(token, API\)/);
    const locationSource = fs.readFileSync('android/app/src/main/java/com/livre/conductor/LocationService.java', 'utf8');
    assert.match(locationSource, /SessionStore\.hasCurrentSession\(this, currentToken, currentApi\)/);
    assert.match(locationSource, /device_id/);
    assert.match(source, /device_id: deviceId/);
  });

  it('renders operational actions in the bottom panel', () => {
    assert.match(source, /operationalControlsHtml/);
    assert.doesNotMatch(source, /Esperando un viaje/);
  });
});
