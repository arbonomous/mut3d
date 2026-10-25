// Transition safety: the moment Blur is selected the outgoing video must be obscured (whole-frame)
// BEFORE the model finishes loading; when a found face is later lost, output must fall back to
// whole-frame blur; Off must restore the raw camera. Uses face-loss.y4m: 5s face, then 6s plain
// grid, looping - so detection flips between found and lost inside one session.
import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; if (u === '/' || u === '/index.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  const f = path.join('public', u); if (!f.startsWith('public') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(fs.readFileSync('dist/index.html')); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(8187);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const errs = [];
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/tmp/face-loss.y4m', '--no-sandbox', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'] });
const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => { errs.push(e.message); console.log('ERR', e.message); }); await p.goto(u); return p; };
const A = await mk('http://localhost:8187/'); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await A.click('#camb'); await wait(2000);
const B = await mk(url); await B.click('#joinbtn'); await B.click('#camb'); await wait(10000);
// remote grid corner variance: high = raw/sharp, low = blurred; sig = whole-frame pixel sum (motion detector)
const gridVar = () => B.evaluate(() => {
  const v = [...document.querySelectorAll('figure')].find((f) => f.__local === false).querySelector('video');
  if (!v || !v.videoWidth) return { g: -1, sig: 0 };
  const c = document.createElement('canvas'); c.width = 240; c.height = 180; const x = c.getContext('2d');
  x.drawImage(v, 0, 0, 240, 180); const d = x.getImageData(2, 2, 36, 36).data; let s = 0;
  for (let i = 4; i < d.length; i += 4) s += Math.abs(d[i] - d[i - 4]);
  const f = x.getImageData(0, 0, 240, 180).data; let sig = 0;
  for (let i = 0; i < f.length; i += 40) sig += f[i];
  return { g: Math.round(s / 1296), sig };
});
// 1. the instant Blur is chosen, before the model can possibly be ready, output must be obscured
await A.click('#more'); await A.selectOption('#face', 'blur');
// selection happens during the moving-face segment: after selection, the source is disabled while
// the sender switches - the remote may briefly hold ALREADY-SENT raw frames (frozen), but must not
// receive NEWLY captured raw frames (a live, changing crisp picture would be a leak)
const early = [];
for (let i = 0; i < 25; i++) { const s = await gridVar(); early.push({ mp: await A.evaluate(() => window.__pr.mp), seen: await A.evaluate(() => window.__pr.faceSeen === true), g: s.g, sig: s.sig }); await wait(100); }
console.log('early samples:', JSON.stringify(early));
// invariant: once the processed track reaches the remote, it is NEVER raw - any crisp frame after
// the first obscured sample must come with a found face (legitimate region blur, sharp background).
// before that, already-captured raw frames can still drain for a few hundred ms (transport tail):
// the source is disabled at selection, so this must be short. measured and bounded, not assumed zero.
const firstObscured = early.findIndex((s) => s.g >= 0 && s.g < 6);
const tail = early.slice(0, firstObscured < 0 ? early.length : firstObscured).filter((s) => s.g > 12);
console.log('switch tail: crisp pre-switch samples =', tail.length, '(~100ms each)');
ok('switch tail bounded: raw drain under 400ms after selection', tail.length <= 3);
const after = firstObscured < 0 ? [] : early.slice(firstObscured);
const processedLeak = after.filter((s) => s.g > 12 && !s.seen);
ok('processed track never emits raw frames (no crisp frame without a found face after switch)', processedLeak.length === 0);
ok('processed track obscured within 800ms of selecting Blur', firstObscured >= 0 && firstObscured < 8);
ok('continuously obscured after the switch while the model loads', early.slice(firstObscured).every((s) => s.g >= 0 && s.g < 6) || early.some((s) => s.mp === 'ready'));
// 2. face found segment: background crisp again (face-region blur active)
// the fixture loops 5s face / 6s grid: poll until a sample lands inside a face segment
let gFace = -1, foundSeen = false;
for (let i = 0; i < 60; i++) { if (await A.evaluate(() => window.__pr.mp === 'ready' && window.__pr.faceSeen === true)) { foundSeen = true; const s2 = await gridVar(); if (await A.evaluate(() => window.__pr.faceSeen === true)) { gFace = s2.g; if (s2.g > 12) break; } } await wait(300); }
console.log('grid var with face found:', gFace);
ok('face found after model ready', foundSeen);
ok('face found: background crisp (region blur, not whole-frame)', gFace > 12);
// 3. tracking loss: fixture moves to the no-face segment, detection expires, whole frame blurs
await A.waitForFunction(() => window.__pr.faceSeen === false, null, { timeout: 30000 }).catch(() => {});
ok('tracking loss detected when face leaves', await A.evaluate(() => window.__pr.faceSeen === false));
await wait(2500);
const gLost = (await gridVar()).g; console.log('grid var after loss:', gLost);
ok('tracking loss: whole frame blurred, never raw', gLost >= 0 && gLost < 6);
// 4. Off restores the untouched camera
await A.selectOption('#face', 'off'); await wait(3000);
const gOff = (await gridVar()).g; console.log('grid var after off:', gOff);
ok('Off restores raw camera', gOff > 12);
ok('no page errors', errs.length === 0);
await b.close(); srv.close(); process.exit(fail ? 1 : 0);
