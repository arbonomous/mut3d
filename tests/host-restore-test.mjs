import { chromium, devices } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8189);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
// Regression: a phone browser that drops tab storage (restored tab) must not turn the host into a waiting guest.
const c = await b.newContext(devices['iPhone 14']); const A = await c.newPage(); await A.goto('http://localhost:8189/'); await A.fill('#name', 'Host'); await A.click('#create');
const invite = A.url().replace(/\.s[\w-]+$/, ''); await A.click('#cam'); await wait(2000);
ok('host before', (await A.textContent('#mode')).includes('You are the host'));
await A.evaluate(() => sessionStorage.clear()); await A.reload(); await wait(600); await A.click('#cam'); await wait(2000);
ok('host after storage wipe still host', (await A.textContent('#mode')).includes('You are the host') && !(await A.isVisible('#wait')));
const G = await (await b.newContext(devices['iPhone 14'])).newPage(); await G.goto(invite); await G.fill('#name', 'Guest'); await G.click('#cam'); await wait(9000);
ok('guest waits', await G.isVisible('#wait'));
ok('host sees knock after restore', (await A.textContent('#knocks')).includes('Guest wants to join'));
await A.click('.knock:not(#bulk) button:first-of-type'); await wait(9000);
ok('guest admitted', !(await G.isVisible('#wait')));
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
