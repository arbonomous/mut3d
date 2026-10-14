import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8171);
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--no-sandbox'] });
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// camera allowed, mic denied
const c1 = await b.newContext(); await c1.grantPermissions(['camera'], { origin: 'http://localhost:8171' });
const p1 = await c1.newPage(); await p1.goto('http://localhost:8171/'); await p1.fill('#name', 'Ann'); await p1.click('#create'); await p1.click('#cam'); await wait(3000);
ok('mic help shown when mic denied', await p1.evaluate(() => !document.querySelector('#michelp').hidden));
await p1.click('#micretry'); await wait(1500);
ok('retry reports still blocked', (await p1.textContent('#micmsg')).includes('Still blocked'));
ok('version v15', (await p1.evaluate(() => document.body.textContent)).includes('v15'));
// both allowed
const b2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] }); const c2 = await b2.newContext();
const p2 = await c2.newPage(); await p2.goto('http://localhost:8171/'); await p2.fill('#name', 'Bo'); await p2.click('#create'); await p2.click('#cam'); await wait(3000);
ok('mic help hidden when mic ok', await p2.evaluate(() => document.querySelector('#michelp').hidden));
await b.close(); await b2.close(); srv.close(); console.log(fail ? 'FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
