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
    assert.match(source, /if \(!NATIVE_SHELL\) startGps\(\);/);
    assert.match(source, /loadOperationalStatus\(\)\.then\(\(\) => loadTrips\(\)\)/);
    assert.doesNotMatch(source, /operationalStatus\s*===\s*['"]out_of_service['"][\s\S]{0,120}stopGps\(/);
  });

  it('only suppresses new-trip announcements while preserving assigned trips', () => {
    assert.match(source, /function announceNewTrip\(t\)/);
    assert.match(source, /operationalStatus === 'out_of_service' \|\| !t/);
    assert.match(source, /selected = trips\.find\(t => t\.status === 'assigned'\) \|\| trips\[0\]/);
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
    assert.match(source, /fontSizeSelect/);
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
    assert.match(sessionStoreSource, /edit\(\)\.clear\(\)\.commit\(\)/);
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
    const locationSource = fs.readFileSync('android/app/src/main/java/com/livre/conductor/LocationService.java', 'utf8');
    assert.match(locationSource, /SessionStore\.hasCurrentSession\(this, currentToken, currentApi\)/);
  });

  it('renders operational actions in the bottom panel', () => {
    assert.match(source, /operationalControlsHtml/);
    assert.doesNotMatch(source, /Esperando un viaje/);
  });
});
