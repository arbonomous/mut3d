import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8184);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection'] });
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; }; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await (await b.newContext()).newPage(); await A.goto('http://localhost:8184/');
// make a noisy 300x200 png via canvas in page, to stress size
const png = await A.evaluate(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#1b6'; x.fillRect(0, 0, 300, 200); x.fillStyle = '#fff'; x.beginPath(); x.arc(150, 100, 70, 0, 7); x.fill(); x.fillStyle = '#17a'; x.fillRect(110, 80, 80, 40); return c.toDataURL('image/png').split(',')[1]; });
await A.getByText('Options', { exact: true }).click(); await A.getByText('Brand this room').click(); await A.fill('#brandname', 'Acme <b>Dental</b>'); await A.selectOption('#brandcolor', '1');
await A.setInputFiles('#brandlogo', { name: 'l.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await wait(800);
ok('logo ready', (await A.textContent('#brandlogonote')) === 'Logo ready');
await A.uncheck('#approve'); await A.click('#create'); await wait(500);
const url = A.url(); console.log('link length', url.length);
ok('join panel shows name as text (no html)', (await A.textContent('#join-brand')).includes('Acme <b>Dental</b>') && (await A.$$('#join-brand b b')).length === 0 && (await A.textContent('#join-brand b')) === 'Acme <b>Dental</b>');
ok('logo img present', (await A.$$('#join-brand img')).length === 1);
await A.click('#camb'); await A.click('#mic'); await wait(2000);
ok('call header branded', (await A.textContent('.top h1')).includes('Acme'));
ok('accent applied', (await A.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--signal'))).trim().toLowerCase() === '#7cc4f2');
const B = await (await b.newContext()).newPage(); await B.goto(url); await wait(600);
ok('guest sees brand before joining', (await B.textContent('#join-brand')).includes('Acme') && (await B.$$('#join-brand img')).length === 1);
await B.click('#joinbtn'); await wait(3000);
ok('guest header branded + connected', (await B.textContent('.top h1')).includes('Acme') && (await B.evaluate(() => window.__pr.conns.size)) === 1);
const C = await (await b.newContext()).newPage(); await C.goto('http://localhost:8184/'); await wait(300);
ok('unbranded room unchanged', !(await C.isVisible('#join-brand')) && (await C.textContent('.top h1')).includes('mut3d'));
// bad logo token ignored
const D = await (await b.newContext()).newPage(); await D.goto(url.split('#')[0] + '#' + url.split('#')[1].split('.')[0] + '.lAAAA<script>'); await wait(300);
ok('malformed logo ignored', (await D.$$('#join-brand img')).length === 0);
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
