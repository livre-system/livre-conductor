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

  it('keeps GPS startup independent from operational status', () => {
    assert.match(source, /startGps\(\);/);
    assert.match(source, /loadOperationalStatus\(\)\.then\(\(\) => startTripsPolling\(\)\)/);
    assert.doesNotMatch(source, /operationalStatus\s*===\s*['"]out_of_service['"][\s\S]{0,120}stopGps\(/);
  });

  it('only suppresses new-trip announcements while preserving assigned trips', () => {
    assert.match(source, /function announceNewTrip\(t\)/);
    assert.match(source, /operationalStatus === 'out_of_service' \|\| !t/);
    assert.match(source, /selected = trips\.find\(t => t\.status === 'assigned'\) \|\|/);
    assert.match(source, /selected\.status === 'completed' \|\| selected\.status === 'cancelled'/);
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
    assert.match(context.finalFareHtml({ fare: 4800, final_fare: 4000 }), /4\.800/);
  });

  it('renders every assigned trip while another trip is selected', () => {
    assert.match(source, /function tripQueueHtml\(current\)/);
    assert.match(source, /data-trip-select=/);
    assert.match(source, /function bindTripQueue\(\)/);
    assert.match(source, /trips\.filter\(t => t\.status === 'assigned'/);
    assert.match(source, /selected = found;/);
  });

  it('moves to the next pending trip after resolving only the selected rejection', () => {
    assert.match(source, /function selectNextPendingTrip\(\)/);
    assert.match(source, /const next = trips\.find\(t => t\.status === 'assigned'\)/);
    assert.match(source, /rejectedTripIds\.add\(String\(selected\.id\)\)/);
    assert.match(source, /trips = trips\.filter\(t => String\(t\.id\) !== String\(selected\.id\)\)/);
    assert.match(source, /selectNextPendingTrip\(\);/);
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
