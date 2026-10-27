const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');

const css = fs.readFileSync('css/styles.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

describe('responsive conductor shell', () => {
  it('keeps login and app shells safe on dynamic-height mobile viewports', () => {
    assert.match(css, /#loginView\s*\{[\s\S]*height: 100svh;[\s\S]*height: 100dvh;/);
    assert.match(css, /#appView\s*\{[\s\S]*height: 100svh;[\s\S]*height: 100dvh;/);
    assert.match(css, /#loginView\s*\{[\s\S]*overflow-y: auto;/);
    assert.match(css, /safe-area-inset-(top|right|bottom|left)/);
  });

  it('has dedicated short-phone and landscape protections', () => {
    assert.match(css, /@media \(max-width: 599px\) and \(max-height: 620px\)/);
    assert.match(css, /@media \(orientation: landscape\) and \(max-height: 520px\)/);
    assert.match(css, /@media \(pointer: coarse\)/);
    assert.match(css, /touch-action: manipulation/);
  });

  it('busts the deployed stylesheet after responsive changes', () => {
    assert.match(html, /css\/styles\.css\?v=responsive-20261027/);
  });
});
