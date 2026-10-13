const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');

const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
const activity = fs.readFileSync('android/app/src/main/java/com/livre/conductor/MainActivity.java', 'utf8');
const gate = fs.readFileSync('android/app/src/main/java/com/livre/conductor/PermissionGate.java', 'utf8');

describe('initial native permission flow', () => {
  it('does not gate operation on unused microphone access', () => {
    assert.doesNotMatch(manifest, /android\.permission\.RECORD_AUDIO/);
    assert.doesNotMatch(activity, /MICROPHONE_REQUEST|Manifest\.permission\.RECORD_AUDIO/);
    assert.doesNotMatch(gate, /NEED_MICROPHONE|RECORD_AUDIO/);
  });

  it('keeps precise and background location in the existing permission gate', () => {
    assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
    assert.match(manifest, /android\.permission\.ACCESS_BACKGROUND_LOCATION/);
    assert.match(gate, /NEED_PRECISE_LOCATION/);
    assert.match(gate, /NEED_BACKGROUND_LOCATION/);
  });

  it('starts after location and notification prerequisites only', () => {
    assert.doesNotMatch(gate, /NEED_MICROPHONE/);
    assert.doesNotMatch(activity, /MICROPHONE_REQUEST/);
  });
});
