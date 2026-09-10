// A guided tour of WHERE the carton-label reprint lives, with red markers
// drawn on the real screen. Order 24944949 is already completed from the
// label9 run, so this only reads and prints — nothing changes.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const ORD = '24944949';
const OUT = __dirname;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  let confirmMsg = '';
  p.on('dialog', d => { confirmMsg = d.message(); d.accept().catch(() => {}); });
  await ctx.addInitScript(() => { window.print = function () {}; });

  // Red ring + numbered arrow label, drawn over any element.
  const mark = (sel, text, dx = 0, dy = 0) => p.evaluate(([sel, text, dx, dy]) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = '__tour';
    ring.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:4px solid #dc2626;border-radius:10px;z-index:999999;pointer-events:none;box-shadow:0 0 0 3px rgba(220,38,38,.25)`;
    document.body.appendChild(ring);
    const tag = document.createElement('div');
    tag.className = '__tour';
    tag.textContent = text;
    tag.style.cssText = `position:fixed;left:${r.left + dx}px;top:${r.bottom + 10 + dy}px;background:#dc2626;color:#fff;font:800 17px -apple-system,Arial;padding:7px 12px;border-radius:8px;z-index:999999;pointer-events:none;max-width:520px;box-shadow:0 4px 14px rgba(0,0,0,.35)`;
    document.body.appendChild(tag);
    return true;
  }, [sel, text, dx, dy]);
  const clearMarks = () => p.evaluate(() => document.querySelectorAll('.__tour').forEach(e => e.remove()));

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);

  // ── STEP 1: the Orders tab, then the Completed sub-tab.
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await mark('[data-tab="orders"]', '1. Orders tab', 10, -4);
  await mark('[data-oview="completed"]', '2. Completed sub-tab', 0, 0);
  await p.screenshot({ path: `${OUT}/tour-1-orders-completed.png`, clip: { x: 0, y: 0, width: 1400, height: 560 } });
  await clearMarks();

  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(2000);

  // ── STEP 2: tick the order's checkbox — the bulk bar appears.
  await p.evaluate((o) => {
    for (const cb of document.querySelectorAll('.ord-select')) if (cb.dataset.order === o) cb.click();
  }, ORD);
  await p.waitForTimeout(600);
  await p.evaluate((o) => {
    const cb = [...document.querySelectorAll('.ord-select')].find(c => c.dataset.order === o);
    cb?.scrollIntoView({ block: 'center' });
  }, ORD);
  await p.waitForTimeout(400);
  await mark(`.ord-select[data-order="${ORD}"]`, '3. Tick the completed order', 10, 0);
  await mark('#ordersBulkCartonLabels', '4. Press 🏷 Carton Labels', 0, 0);
  await p.screenshot({ path: `${OUT}/tour-2-tick-and-button.png`, clip: { x: 0, y: 0, width: 1400, height: 560 } });
  await clearMarks();

  // ── STEP 3: press it — the confirm states how many labels are coming.
  await p.click('#ordersBulkCartonLabels');
  await p.waitForTimeout(3000);
  console.log('CONFIRM SAID:', confirmMsg);

  // ── STEP 4: the labels, as they go to the printer.
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    if (f) f.style.cssText = 'position:fixed;left:490px;top:5px;width:420px;height:940px;border:3px solid #dc2626;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const tag = document.createElement('div');
    tag.textContent = '5. Both boxes reprint — final CTN n / 2, each with its contents';
    tag.style.cssText = 'position:fixed;left:20px;top:20px;background:#dc2626;color:#fff;font:800 18px -apple-system,Arial;padding:10px 14px;border-radius:8px;z-index:999999;max-width:420px;box-shadow:0 4px 14px rgba(0,0,0,.35)';
    document.body.appendChild(tag);
  });
  await p.screenshot({ path: `${OUT}/tour-3-labels.png`, clip: { x: 0, y: 0, width: 930, height: 950 } });

  await b.close();
  console.log('DONE');
})();
