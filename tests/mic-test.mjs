import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8171);
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--no-sandbox'] });
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// camera allowed, mic denied
const c1 = await b.newContext(); await c1.grantPermissions(['camera'], { origin: 'http://localhost:8171' });
const p1 = await c1.newPage(); await p1.goto('http://localhost:8171/'); await p1.fill('#name', 'Ann'); await p1.click('#create'); await p1.click('#mic'); await wait(3000);
ok('mic help shown when mic denied', await p1.evaluate(() => !document.querySelector('#michelp').hidden));
await p1.click('#micretry'); await wait(1500);
ok('retry reports still blocked', (await p1.textContent('#micmsg')).includes('Still blocked'));
ok('version shown', /\(v\d+\)/.test(await p1.evaluate(() => document.body.textContent)));
// both allowed
const b2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] }); const c2 = await b2.newContext();
const p2 = await c2.newPage(); await p2.goto('http://localhost:8171/'); await p2.fill('#name', 'Bo'); await p2.click('#create'); await p2.click('#mic'); await wait(3000);
ok('mic help hidden when mic ok', await p2.evaluate(() => document.querySelector('#michelp').hidden));
// per-browser steps
const UAS = { safari: ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1', /aA/, /Safari/], chrome: ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', /icon left of the address bar/, /Chrome/], other: ['Mozilla/5.0 (Linux; Android 14) Gecko/130 Firefox/130', /your browser/, /^$/] };
for (const [k, [ua, a, w]] of Object.entries(UAS)) {
  const cx = await b.newContext({ userAgent: ua }); await cx.grantPermissions(['camera'], { origin: 'http://localhost:8171' });
  const pg = await cx.newPage(); await pg.goto('http://localhost:8171/'); await pg.fill('#name', 'X'); await pg.click('#create'); await pg.click('#mic'); await wait(2500);
  const st = await pg.textContent('#micsteps'), who = await pg.textContent('#micwho');
  ok('steps for ' + k, a.test(st) && w.test(who) && !/same iPhone microphone/.test(await pg.textContent('#michelp')));
}
await b.close(); await b2.close(); srv.close(); console.log(fail ? 'FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
