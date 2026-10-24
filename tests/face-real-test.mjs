// Runs the avatar and mask on a real photo of a face (fed as the fake camera) to check detection and drawing. Needs /tmp/face.y4m.
import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs'; import path from 'path';
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => { const u = q.url.split('?')[0]; const f = path.join('public', u); if (u !== '/' && f.startsWith('public') && fs.existsSync(f) && fs.statSync(f).isFile()) { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); return r.end(fs.readFileSync(f)); } r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8186);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/tmp/face.y4m', '--no-sandbox'] });
const p = await (await b.newContext()).newPage(); p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:8186/'); await p.uncheck('#approve'); await p.click('#create'); await p.click('#camb'); await new Promise((r) => setTimeout(r, 3000));
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
await p.click('#more');
for (const m of ['avatar', 'mask']) {
  if (m === 'mask') await p.click('#more');
  await p.selectOption('#face', m); await new Promise((r) => setTimeout(r, 9000));
  const st = await p.evaluate(() => ({ mp: window.__pr.mp, seen: window.__pr.faceSeen, err: window.__pr.mpErr }));
  console.log(m, JSON.stringify(st)); ok(m + ': face detected on a real photo', st.seen === true);
  const shot = await p.evaluate(() => { const c = document.querySelector('figure video').srcObject; return null; });
  await p.click('#more'); await new Promise((r) => setTimeout(r, 500)); const du = await p.evaluate(() => window.__pr.faceCanvas.toDataURL('image/png')); fs.writeFileSync('/tmp/cv-' + m + '.png', Buffer.from(du.split(',')[1], 'base64')); const el = await p.$('figure'); await el.screenshot({ path: '/tmp/face-' + m + '.png' });
}
await b.close(); srv.close(); process.exit(fail ? 1 : 0);
