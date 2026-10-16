import { chromium, devices } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8191);
const b = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); let fail = 0; const ok = (n, c, x) => { console.log(c ? 'PASS' : 'FAIL', n, x || ''); if (!c) fail++; };
const contrast = () => {
  const parse = (c) => c.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (e) => { while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0.5) { if (c.length >= 3 && !(c.length === 4 && c[3] === 0)) return c.slice(0, 3); } e = e.parentElement; } return [255, 255, 255]; };
  const out = [];
  for (const e of document.querySelectorAll('#gate input:not([type=checkbox]):not([type=file]), #gate select, #gate summary, #gate .row span, #gate .row small, #gate .lead, #gate .fine, #gate h1, #gate button.big, #gate .tag')) {
    if (!e.offsetParent) continue; const fg = parse(getComputedStyle(e).color).slice(0, 3), bg = bgOf(e); const a = lum(fg), c = lum(bg); const cr = (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
    out.push([e.id || e.className || e.tagName, +cr.toFixed(2)]);
  } return out;
};
for (const th of ['light', 'dark']) {
  const c = await b.newContext({ ...devices['iPhone 14'], colorScheme: th }); const p = await c.newPage(); await p.addInitScript((t) => localStorage.setItem('mut3d-theme', t), th);
  await p.goto('http://localhost:8191/'); await p.getByText('Options', { exact: true }).click(); await p.getByText('Brand this room').click(); await p.waitForTimeout(300);
  const r = await p.evaluate(contrast); const bad = r.filter((x) => x[1] < 3.5); ok(th + ' start screen contrast >= 3.5 (' + r.length + ' items)', bad.length === 0, JSON.stringify(bad));
  await p.fill('#name', 'Host'); await p.getByText('Options', { exact: true }).click(); await p.click('#create'); await p.click('#cam'); await wait(2000);
  const inv = p.url().replace(/\.s[\w-]+$/, '');
  const g = await (await b.newContext({ ...devices['iPhone 14'], colorScheme: th })).newPage(); await g.addInitScript((t) => localStorage.setItem('mut3d-theme', t), th); await g.goto(inv); await g.waitForTimeout(500); await g.screenshot({ path: `/tmp/join-${th}.png` });
  await g.click('#cam'); await wait(8000); await g.screenshot({ path: `/tmp/wait-${th}.png` }); await p.screenshot({ path: `/tmp/call-${th}.png` });
}
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
