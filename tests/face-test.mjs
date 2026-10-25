import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; if (u === '/' || u === '/index.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  const f = path.join('public', u); if (!f.startsWith('public') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(8185);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const errs = []; const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => { errs.push(e.message); console.log('ERR', e.message); }); await p.goto(u); return p; };
const A = await mk('http://localhost:8185/'); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await A.click('#camb'); await wait(2000);
const B = await mk(url); await B.click('#joinbtn'); await B.click('#camb'); await wait(14000);
const probe = () => B.evaluate(async () => {
  const v = [...document.querySelectorAll('figure')].find((f) => f.__local === false).querySelector('video');
  const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 1200));
  return { w: v.videoWidth, moving: v.currentTime > t0 };
});
// mean abs horizontal pixel difference of the remote frame: a sharp test pattern scores high, a blurred one low
const sharp = () => B.evaluate(async () => {
  const v = [...document.querySelectorAll('figure')].find((f) => f.__local === false).querySelector('video');
  const c = document.createElement('canvas'); c.width = 160; c.height = 120; const x = c.getContext('2d');
  x.drawImage(v, 0, 0, 160, 120); const d = x.getImageData(0, 0, 160, 120).data; let s = 0, n = 0;
  for (let y = 0; y < 120; y += 4) for (let xx = 1; xx < 160; xx++) { const i = (y * 160 + xx) * 4; s += Math.abs(d[i] - d[i - 4]); n++; }
  return s / n;
});
const base = await probe(); console.log('base', base); ok('remote video flowing', base.w > 0 && base.moving);
const opts = await A.evaluate(() => [...document.querySelectorAll('#face option')].map((o) => o.value));
console.log(opts.join(',')); ok('picker is exactly off + blur', opts.length === 2 && opts[0] === 'off' && opts[1] === 'blur');
const rawSharp = await sharp(); console.log('raw sharpness', rawSharp);
await A.click('#more'); await A.selectOption('#face', 'blur'); await wait(2500);
const bl = await probe(); ok('blur flows at 480', bl.moving && bl.w === 480);
const blurSharp = await sharp(); console.log('blur sharpness', blurSharp); ok('blur is visibly blurrier than raw', blurSharp < rawSharp * 0.6);
const mpReqs = await A.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/mp/') || /mediapipe|googleapis|jsdelivr|unpkg/.test(n)));
console.log('model/third-party requests:', JSON.stringify(mpReqs)); ok('no model files or third-party requests', mpReqs.length === 0);
await A.selectOption('#face', 'off'); await wait(3000); const off = await probe(); ok('off restores raw camera', off.moving && off.w === 640);
// speaker highlight + enlarge
const lv = await B.evaluate(async () => { await new Promise((r) => setTimeout(r, 2500)); return { levels: window.__pr.levels, talk: document.querySelectorAll('figure.talk').length }; });
console.log('levels', JSON.stringify(lv)); ok('audio levels measured', lv.levels && lv.levels.length === 2);
await B.evaluate(() => [...document.querySelectorAll('figure')][0].click()); await wait(300);
const en = await B.evaluate(() => ({ big: document.querySelectorAll('figure.big').length, hasbig: document.querySelector('#videos').classList.contains('hasbig') })); ok('tap enlarges one tile', en.big === 1 && en.hasbig);
await B.screenshot({ path: '/tmp/enlarged.png' });
await B.evaluate(() => [...document.querySelectorAll('figure')][0].click()); await wait(300);
ok('tap again restores', await B.evaluate(() => document.querySelectorAll('figure.big').length === 0 && !document.querySelector('#videos').classList.contains('hasbig')));
// PWA files
for (const f of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png']) { const r = await A.evaluate(async (x) => (await fetch(x)).status, f); ok('serves ' + f, r === 200); }
ok('no page errors', errs.length === 0);
await b.close(); srv.close(); process.exit(fail ? 1 : 0);
