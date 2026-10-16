import { chromium, devices } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8187);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const mk = async (u, prof) => { const c = await b.newContext(prof || {}); const p = await c.newPage(); await p.goto(u); return p; };
const pad = (n) => String(n).padStart(2, '0');
for (const mode of ['plain', 'scheduled+preinvite', 'branded']) {
  const A = await mk('http://localhost:8187/', devices['iPhone 14']); await A.fill('#name', 'Host');
  if (mode !== 'plain') await A.getByText('Options', { exact: true }).click();
  if (mode === 'scheduled+preinvite') { const d = new Date(Date.now() + 7200000); await A.fill('#when', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`); }
  if (mode === 'branded') { await A.getByText('Brand this room').click(); await A.fill('#brandname', 'Acme'); await A.selectOption('#brandcolor', '2'); }
  await A.click('#create'); await wait(400);
  let invite;
  if (mode === 'scheduled+preinvite') { await A.click('#joininvite'); await wait(300); invite = await A.evaluate(() => document.querySelector('#invurl').textContent); await A.click('#invclose'); const full = await A.evaluate(() => location.href); invite = full.replace(/\.s[\w-]+$/, ''); }
  else invite = A.url().replace(/\.s[\w-]+$/, '');
  await A.click('#cam'); await wait(2500);
  const G = await mk(invite, devices['iPhone 14']); await G.fill('#name', 'Guest'); await G.click('#cam'); await wait(9000);
  ok(mode + ': guest waiting', await G.isVisible('#wait'));
  const t = await A.textContent('#knocks'); ok(mode + ': host sees knock: ' + t.slice(0, 30), t.includes('Guest wants to join'));
  const box = await A.evaluate(() => { const r = document.querySelector('.knock:not(#bulk)')?.getBoundingClientRect(); return r && [r.top, r.bottom, innerHeight, getComputedStyle(document.querySelector('#knocks')).display]; }); console.log(mode, JSON.stringify(box));
  await A.screenshot({ path: '/tmp/knock-' + mode.slice(0, 5) + '.png' });
  await A.click('.knock:not(#bulk) button:first-of-type'); await wait(9000);
  ok(mode + ': admitted', !(await G.isVisible('#wait')));
}
console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); await b.close(); srv.close(); process.exit(fail ? 1 : 0);
