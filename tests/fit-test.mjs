import { chromium, devices } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8193);
const b = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); let fail = 0; const ok = (n, c, x) => { console.log(c ? 'PASS' : 'FAIL', n, x || ''); if (!c) fail++; };
const over = () => { const W = document.documentElement.clientWidth, out = []; for (const e of document.querySelectorAll('body *')) { if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') continue; const r = e.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push((e.id || e.className || e.tagName) + ':' + Math.round(r.left) + '-' + Math.round(r.right)); } return { W, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth, vv: visualViewport.width, scale: visualViewport.scale, out: out.slice(0, 8) }; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
for (const dev of ['iPhone 14', 'iPhone SE', 'iPhone 14 Pro Max']) for (const brand of [false, true]) {
  const c = await b.newContext({ ...devices[dev] }); const p = await c.newPage(); await p.goto('http://localhost:8193/'); await p.fill('#name', 'Jose Gorbea Long Name');
  if (brand) { await p.getByText('Options', { exact: true }).click(); await p.getByText('Brand this room').click(); await p.fill('#brandname', 'Very Long Room Name Here'); }
  const j = await p.evaluate(over); ok(`${dev} ${brand ? 'branded ' : ''}gate screen fits`, j.sw <= j.W && j.out.length === 0, JSON.stringify(j));
  await p.click('#create'); await wait(1500);
  const g = await c.newPage(); await g.goto(p.url()); await wait(800); const gv = await g.evaluate(over); ok(`${dev} ${brand ? 'branded ' : ''}invite screen fits`, gv.sw <= gv.W && gv.out.length === 0, JSON.stringify(gv));
  const s = await p.evaluate(over); ok(`${dev} ${brand ? 'branded ' : ''}call screen fits`, s.sw <= s.W && s.out.length === 0 && Math.abs(s.scale - 1) < 0.01, JSON.stringify(s));
  await c.close();
}
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
