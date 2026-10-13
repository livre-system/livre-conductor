const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync('js/app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

describe('driver history and shift closure', () => {
  it('offers a history view with date filters and totals', () => {
    assert.match(html, /historyButton/);
    assert.match(html, /historyModal/);
    assert.match(source, /async function loadDriverHistory\(\)/);
    assert.match(source, /date_from/);
    assert.match(source, /date_to/);
    assert.match(source, /total_revenue/);
  });

  it('shows a shift summary and confirms the persisted closure', () => {
    assert.match(source, /function renderHistory\(/);
    assert.match(source, /async function closeDriverShift\(\)/);
    assert.match(source, /\/mobility\/driver\/shift-closures/);
    assert.match(source, /confirm\(/);
  });

  it('downloads or shares the internal PDF without monthly commission data', () => {
    assert.match(source, /async function downloadShiftPdf\(closureId\)/);
    assert.match(source, /application\/pdf/);
    assert.match(source, /navigator\.share/);
    assert.doesNotMatch(source, /comisi[oó]n mensual/i);
  });
});
