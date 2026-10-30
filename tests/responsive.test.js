const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');

const css = fs.readFileSync('css/styles.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('js/app.js', 'utf8');

describe('responsive conductor shell', () => {
  it('keeps login and app shells safe on dynamic-height mobile viewports', () => {
    assert.match(css, /#loginView\s*\{[\s\S]*height: 100svh;[\s\S]*height: 100dvh;/);
    assert.match(css, /#appView\s*\{[\s\S]*height: 100svh;[\s\S]*height: 100dvh;/);
    assert.match(css, /#loginView\s*\{[\s\S]*overflow-y: auto;/);
    assert.match(css, /safe-area-inset-(top|right|bottom|left)/);
    assert.match(css, /padding: 0 20px max\(56px, calc\(env\(safe-area-inset-bottom\) \+ 24px\)\)/);
  });

  it('has dedicated short-phone and landscape protections', () => {
    assert.match(css, /@media \(max-width: 599px\) and \(max-height: 620px\)/);
    assert.match(css, /@media \(orientation: landscape\) and \(max-height: 520px\)/);
    assert.match(css, /@media \(pointer: coarse\)/);
    assert.match(css, /touch-action: manipulation/);
  });

  it('uses a GPS-aware waiting message instead of contradicting an active GPS state', () => {
    assert.match(js, /gpsState\.provider === 'ACTIVE' \? 'GPS activo · ubicando en la ruta'/);
    assert.match(js, /'Esperando GPS preciso'/);
  });

  it('busts the deployed stylesheet after responsive changes', () => {
    assert.match(html, /css\/styles\.css\?v=(?:operational-mobile|trip-flow-mobile|trip-flow-clean-map|front-refine|conductor-trip-layout)-202610(?:29|30)/);
  });
});
