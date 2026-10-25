// Real-face blur test: feeds actual face footage as the camera and checks the PROCESSED pixels,
// locally and on the remote side: face region heavily blurred, background stays crisp, and the
// whole frame is blurred (never raw) while the model loads, when no face is found, or on failure.
// Fixtures in /tmp (rebuild per docs): face-static.y4m, face-move.y4m, face-two.y4m.
import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; if (u === '/' || u === '/index.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  const f = path.join('public', u); if (!f.startsWith('public') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(8186);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const errs = [];
const launch = (file) => chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(file ? ['--use-file-for-fake-video-capture=' + file] : []), '--no-sandbox', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'] });
const ANALYZE = `(() => {
  const src = window.__pr && window.__pr.faceCanvas && window.__probeLocal ? window.__pr.faceCanvas : (() => { const f = [...document.querySelectorAll('figure')].find((f) => f.__local === false); return f && f.querySelector('video'); })();
  if (!src || !(src.videoWidth || src.width)) return null;
  const w = 240, h = 180, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h);
  const v = (x0, y0, bw, bh) => { const d = x.getImageData(x0, y0, bw, bh).data; let s = 0; for (let i = 4; i < d.length; i += 4) s += Math.abs(d[i] - d[i - 4]); return Math.round(s / (bw * bh)); };
  // grid corner (sharp when background untouched), and variance map for blob location
  const grid = v(2, 2, 36, 36);
  let best = null;
  for (let by = 0; by + 30 <= h; by += 10) for (let bx = 0; bx + 30 <= w; bx += 10) { const vv = v(bx, by, 30, 30); if (!best || vv < best.v) best = { v: vv, cx: bx + 15, cy: by + 15 }; }
  return { grid, minVar: best.v, minCx: best.cx, minCy: best.cy, sb: v(90, 55, 60, 60), lb: v(30, 55, 50, 50), rb: v(150, 55, 50, 50) };
})()`;
async function mkCall(b) {
  const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => { errs.push(e.message); console.log('ERR', e.message); }); await p.goto(u); return p; };
  const A = await mk('http://localhost:8186/'); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await A.click('#camb'); await wait(2000);
  const B = await mk(url); await B.click('#joinbtn'); await B.click('#camb'); await wait(10000);
  return { A, B };
}
// fixture geometry: 640x480 -> 240x180 analysis: static face box ~ x135..345/4, y75..285/4

// 1. static single face
let b = await launch('/tmp/face-static.y4m');
let { A, B } = await mkCall(b);
await A.click('#more'); await A.selectOption('#face', 'blur');
await A.waitForFunction(() => window.__pr.mp === 'ready', null, { timeout: 30000 }).catch(() => {});
ok('model loads from own origin', await A.evaluate(() => window.__pr.mp === 'ready'));
await A.waitForFunction(() => window.__pr.faceSeen === true, null, { timeout: 20000 }).catch(() => {});
ok('face detected in static fixture', await A.evaluate(() => window.__pr.faceSeen === true));
await wait(2500);
let an = await B.evaluate(ANALYZE); console.log('static remote:', JSON.stringify(an));
ok('remote: background grid stays crisp', an && an.grid > 12);
ok('remote: face region heavily blurred', an && an.sb < an.grid * 0.35);
await b.close();

// 2. moving face: detection holds and the blurred blob follows (checked on the processed canvas)
b = await launch('/tmp/face-move.y4m'); ({ A, B } = await mkCall(b));
await A.click('#more'); await A.selectOption('#face', 'blur');
await A.waitForFunction(() => window.__pr.faceSeen === true, null, { timeout: 45000 }).catch(() => {});
await A.evaluate(() => { window.__probeLocal = true; });
const m1 = await A.evaluate(ANALYZE); await wait(2600); const m2 = await A.evaluate(ANALYZE);
await A.evaluate(() => { window.__probeLocal = false; });
const seen1 = await A.evaluate(() => window.__pr.faceSeen); await wait(1500); const seen2 = await A.evaluate(() => window.__pr.faceSeen);
console.log('move t1:', JSON.stringify(m1), 't2:', JSON.stringify(m2), 'seen:', seen1, seen2);
ok('moving: face tracked over time', seen1 === true && seen2 === true);
ok('moving: blur blob follows the face', m1 && m2 && Math.abs(m1.minCx - m2.minCx) > 8);
const rm = await B.evaluate(ANALYZE);
ok('moving: remote background still crisp', rm && rm.grid > 12);
await b.close();

// 3. two faces in frame: both blurred
b = await launch('/tmp/face-two.y4m'); ({ A, B } = await mkCall(b));
await A.click('#more'); await A.selectOption('#face', 'blur');
await A.waitForFunction(() => (window.__pr.faceCount || 0) >= 2, null, { timeout: 45000 }).catch(() => {});
console.log('two: count', await A.evaluate(() => window.__pr.faceCount));
await wait(2500);
an = await B.evaluate(ANALYZE); console.log('two remote:', JSON.stringify(an));
ok('two faces detected', await A.evaluate(() => (window.__pr.faceCount || 0) >= 2));
ok('remote: grid crisp with faces', an && an.grid > 12);
ok('remote: both faces blurred', an && an.lb < an.grid * 0.75 && an.rb < an.grid * 0.75);
await b.close();

// 4. no face (plain test pattern): whole frame blurred, never raw
b = await launch(null); ({ A, B } = await mkCall(b));
await A.click('#more'); await A.selectOption('#face', 'blur'); await wait(6000);
an = await B.evaluate(ANALYZE); console.log('no-face remote:', JSON.stringify(an));
ok('no face found: whole frame blurred (crisp pattern unreadable)', an && an.grid < 6);
await b.close();

// 5. model fails to load: still obscured, never raw, honest notice
b = await launch('/tmp/face-static.y4m');
const ctxA = await b.newContext(); const pA = await ctxA.newPage();
await pA.route('**/mp/**', (r) => r.abort());
pA.on('pageerror', (e) => { errs.push(e.message); console.log('ERR', e.message); });
await pA.goto('http://localhost:8186/'); await pA.uncheck('#approve'); await pA.click('#create'); const url2 = pA.url(); await pA.click('#camb'); await wait(2000);
const ctxB = await b.newContext(); const pB = await ctxB.newPage(); pB.on('pageerror', (e) => { errs.push(e.message); console.log('ERR', e.message); }); await pB.goto(url2); await pB.click('#joinbtn'); await pB.click('#camb'); await wait(10000);
await pA.click('#more'); await pA.selectOption('#face', 'blur'); await wait(8000);
console.log('mp blocked:', await pA.evaluate(() => window.__pr.mp));
ok('model blocked: failure state visible', (await pA.evaluate(() => String(window.__pr.mp))).startsWith('failed'));
ok('honest failure notice shown', /could not load|stays blurred/i.test(await pA.evaluate(() => document.body.textContent)));
an = await pB.evaluate(ANALYZE); console.log('model-fail remote:', JSON.stringify(an));
ok('model fail: whole frame blurred, never raw', an && an.grid < 6);
await b.close();

ok('no page errors', errs.length === 0);
srv.close(); process.exit(fail ? 1 : 0);
