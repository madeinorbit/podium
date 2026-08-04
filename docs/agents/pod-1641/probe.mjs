import { firefox } from 'playwright';

const COOKIE = process.env.PODIUM_COOKIE;
const URL = 'http://127.0.0.1:18787/';

const b = await firefox.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' }]);

// in-page instrument: stall detector + request counter, installed before app code
await ctx.addInitScript(() => {
  window.__probe = { stalls: [], reqs: [], marks: [] };
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last - 20;
    if (gap > 50) window.__probe.stalls.push({ t: Math.round(now), gap: Math.round(gap) });
    last = now;
  }, 20);
  const of = window.fetch;
  window.fetch = function (...a) {
    const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '?';
    const t0 = performance.now();
    const rec = { url: String(url).slice(0, 120), t: Math.round(t0), dur: -1 };
    window.__probe.reqs.push(rec);
    return of.apply(this, a).then(r => { rec.dur = Math.round(performance.now() - t0); return r; },
      e => { rec.dur = Math.round(performance.now() - t0); rec.err = String(e); throw e; });
  };
});

const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 200)); });

console.log('goto...');
const t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('domcontentloaded', Date.now() - t0, 'ms');

// wait for the app to have real content
for (let i = 0; i < 120; i++) {
  const n = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
  if (n > 20000) { console.log('content', n, 'chars at', Date.now() - t0, 'ms'); break; }
  await new Promise(r => setTimeout(r, 500));
}

async function probeMainThread(label, seconds) {
  const out = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const s = Date.now();
    try { await page.evaluate(() => 1 + 1, { timeout: 10000 }); } catch { out.push(-1); continue; }
    out.push(Date.now() - s);
    await new Promise(r => setTimeout(r, 100));
  }
  const sorted = out.filter(x => x >= 0).sort((a, b) => a - b);
  console.log(`[${label}] n=${out.length} timeouts=${out.filter(x=>x<0).length} p50=${sorted[Math.floor(sorted.length*0.5)]} p95=${sorted[Math.floor(sorted.length*0.95)]} max=${sorted[sorted.length-1]}`);
  return out;
}

await probeMainThread('idle-baseline', 10);

// find the picker
const sel = 'text=/Choose agent and repo/i';
const has = await page.locator(sel).count();
console.log('picker candidates:', has);
if (has) {
  const clickStart = Date.now();
  await page.locator(sel).first().click({ timeout: 5000, force: true }).catch(e => console.log('click err', e.message.slice(0,120)));
  console.log('click returned in', Date.now() - clickStart, 'ms');
  await probeMainThread('after-picker-click', 20);
}

// scroll probe
await page.mouse.move(700, 500);
const scrollStart = Date.now();
for (let i = 0; i < 6; i++) {
  const s = Date.now();
  await page.mouse.wheel(0, 600).catch(e => console.log('wheel err', e.message.slice(0,80)));
  console.log('wheel', i, Date.now() - s, 'ms');
  await new Promise(r => setTimeout(r, 400));
}
console.log('scroll total', Date.now() - scrollStart, 'ms');
await probeMainThread('after-scroll', 15);

const probe = await page.evaluate(() => window.__probe, { timeout: 60000 });
const stalls = probe.stalls.sort((a, b) => b.gap - a.gap);
console.log('TOP STALLS (main-thread blocked ms):', JSON.stringify(stalls.slice(0, 15)));
console.log('stall count', stalls.length, 'total blocked ms', stalls.reduce((s, x) => s + x.gap, 0));
const byUrl = {};
for (const r of probe.reqs) { const k = r.url.replace(/[?#].*/, '').split('/').slice(-1)[0]; byUrl[k] = byUrl[k] || { n: 0, total: 0, max: 0 }; byUrl[k].n++; byUrl[k].total += Math.max(0, r.dur); byUrl[k].max = Math.max(byUrl[k].max, r.dur); }
console.log('REQUESTS total', probe.reqs.length);
console.log(JSON.stringify(Object.entries(byUrl).sort((a,b)=>b[1].total-a[1].total).slice(0,15), null, 1));
await b.close();
