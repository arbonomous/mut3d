import { chromium, devices } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8192);
const b = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); let fail = 0; const ok = (n, c, x) => { console.log(c ? 'PASS' : 'FAIL', n, x || ''); if (!c) fail++; };
// A noisy "photo" logo, and a Safari-like browser that cannot save webp.
for (const safari of [false, true]) for (const th of ['light', 'dark']) {
  const c = await b.newContext({ ...devices['iPhone 14'], colorScheme: th }); const p = await c.newPage();
  await p.addInitScript(([t, sf]) => { localStorage.setItem('mut3d-theme', t); if (sf) { const o = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function (m, q) { return o.call(this, m === 'image/webp' ? 'image/png' : m, q); }; } }, [th, safari]);
  await p.goto('http://localhost:8192/');
  const png = await p.evaluate(async () => { const cv = document.createElement('canvas'); cv.width = 800; cv.height = 600; const x = cv.getContext('2d'); for (let i = 0; i < 3000; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,${30 + (i % 40)}%)`; x.fillRect((i * 97) % 800, (i * 53) % 600, 40, 40); } return cv.toDataURL('image/png').split(',')[1]; });
  await p.fill('#name', 'Jose'); await p.getByText('Options', { exact: true }).click(); await p.getByText('Brand this room').click(); await p.fill('#brandname', 'Glizzy Room'); await p.selectOption('#brandcolor', '3');
  await p.setInputFiles('#brandlogo', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await wait(1200);
  const note = await p.textContent('#brandlogonote'); const tag = (safari ? 'safari-sim ' : '') + th;
  ok(tag + ': busy photo logo accepted', note === 'Logo ready', note);
  await p.getByText('Options', { exact: true }).click(); await p.click('#create'); await wait(600);
  const url = p.url(); ok(tag + ': link fits a QR (<2800 chars)', url.length < 2800, String(url.length));
  const jo = await p.evaluate(() => { const i = document.querySelector('#join-brand img'); return i && [i.naturalWidth, i.getBoundingClientRect().width]; });
  ok(tag + ': logo shows on join screen', jo && jo[0] > 0 && jo[1] >= 70, JSON.stringify(jo));
  await p.screenshot({ path: `/tmp/join2-${safari ? 's' : 'c'}-${th}.png` });
  await p.click('#cam'); await wait(2000);
  const hd = await p.evaluate(() => { const i = document.querySelector('.top img.bavatar'); return { img: i && i.naturalWidth, w: i && i.getBoundingClientRect().width, h1: document.querySelector('.top h1').textContent, sub: document.querySelector('#sub').textContent, subVisible: !document.querySelector('#sub').hidden, mark: getComputedStyle(document.querySelector('#topmark')).display, title: document.title }; });
  ok(tag + ': header shows logo, name and mut3d line', hd.img > 0 && hd.w >= 36 && hd.h1 === 'Glizzy Room' && hd.subVisible && hd.sub.includes('mut3d') && hd.title.includes('mut3d'), JSON.stringify(hd));
  await p.screenshot({ path: `/tmp/call2-${safari ? 's' : 'c'}-${th}.png` });
  await c.close();
}
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
