const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('js/app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

function historyTotals(data) {
  const start = source.indexOf('const money =');
  const end = source.indexOf('function localDateInput');
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.historyTotals = historyTotals;`, context);
  return context.historyTotals(data);
}

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
    assert.match(source, /Total facturado/);
    assert.match(source, /Importe del conductor/);
    assert.match(source, /Comisiones/);
    assert.match(source, /Resumen final del día/);
    assert.match(source, /function historyTotals\(/);
    assert.match(source, /No informado/);
    assert.doesNotMatch(source, /fare\) \* 0\.85/);
    assert.match(source, /async function closeDriverShift\(\)/);
    assert.match(source, /\/mobility\/driver\/shift-closures/);
    assert.match(source, /confirm\(/);
  });

  it('uses explicit backend totals for a complete response', () => {
    assert.deepEqual(historyTotals({
      total: 4,
      total_revenue: 12000,
      driver_revenue: 10200,
      commission: 1800,
      items: [{ fare: 999999 }],
    }), { trips: 4, billed: 12000, driver: 10200, commission: 1800 });
  });

  it('does not infer missing amounts from items in a partial response', () => {
    assert.deepEqual(historyTotals({
      trip_count: 2,
      total_revenue: 5000,
      items: [{ fare: 3000 }, { fare: 2000 }],
    }), { trips: 2, billed: 5000, driver: null, commission: null });
  });

  it('downloads or shares the internal PDF without monthly commission data', () => {
    assert.match(source, /async function downloadShiftPdf\(closureId\)/);
    assert.match(source, /application\/pdf/);
    assert.match(source, /navigator\.share/);
    assert.doesNotMatch(source, /comisi[oó]n mensual/i);
  });
});
