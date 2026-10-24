import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const URL0 = process.env.URL0; let srv; let base = URL0;
if (!URL0) { srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8125); base = 'http://localhost:8125/'; }
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection'] });
const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); await p.goto(u); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await mk(base); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await wait(2500);
const rid = await A.evaluate(() => window.__pr.roomId);
const X = await mk(base);
const res = await X.evaluate(async (rid) => {
  const { Peer } = window.__pr; const out = { open: 0, got: [], reflected: 0, laterData: 0, stream: 0 };
  const p = new Peer(rid + '-3', { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
  await new Promise((r) => p.on('open', r));
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; cv.getContext('2d').fillRect(0, 0, 9, 9);
  const st = cv.captureStream(10);
  const c = p.connect(rid + '-0', { reliable: true });
  c.on('open', () => { out.open++; });
  c.on('data', (d) => {
    const u = new Uint8Array(d.buffer ? d.buffer : d); out.got.push(u[0]);
    if (u[0] === 2 && !out.reflected) { const r = u.slice(); r[0] = 3; c.send(r); out.reflected++; } else out.laterData++;
  });
  const call = p.call(rid + '-0', st); call.on('stream', () => out.stream++);
  await new Promise((r) => setTimeout(r, 12000));
  return out;
}, rid);
console.log('attacker', JSON.stringify(res));
const stA = await A.evaluate(() => ({ conns: [...window.__pr.conns.keys()], vids: document.querySelectorAll('video').length }));
console.log('A', JSON.stringify(stA));
const pass = res.reflected === 1 && res.laterData === 0 && res.stream === 0 && stA.conns.length === 0;
console.log(pass ? 'REFLECT PASS: attacker not admitted' : 'REFLECT FAIL: attacker admitted');
await b.close(); srv && srv.close(); process.exit(pass ? 0 : 1);
