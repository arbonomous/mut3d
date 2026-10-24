import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const URL0 = process.env.URL0;
let srv; let base = URL0;
if (!URL0) { srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8124); base = 'http://localhost:8124/'; }
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection'] });
const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); await p.goto(u); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await mk(base); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await wait(2500);
const B = await mk(url); await B.click('#joinbtn'); await wait(9000);
const rid = await A.evaluate(() => window.__pr.roomId);
console.log('baseline A conns', await A.evaluate(() => window.__pr.conns.size), 'room', rid);
// attacker: knows the broker peer ids (room id hash) but NOT the key
const X = await mk(base);
const res = await X.evaluate(async (rid) => {
  const { Peer } = window.__pr; const out = { open: 0, data: 0, stream: 0, calls: 0, closed: 0 };
  const p = new Peer(rid + '-3', { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
  await new Promise((r) => p.on('open', r));
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; cv.getContext('2d').fillRect(0, 0, 9, 9);
  const st = cv.captureStream(10);
  for (let i = 0; i < 3; i++) {
    const c = p.connect(rid + '-' + i, { reliable: true });
    c.on('open', () => { out.open++; c.send(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])); c.send('hello'); });
    c.on('data', () => out.data++); c.on('close', () => out.closed++);
    const call = p.call(rid + '-' + i, st); out.calls++;
    call.on('stream', () => out.stream++);
  }
  await new Promise((r) => setTimeout(r, 14000));
  return out;
}, rid);
console.log('attacker result', JSON.stringify(res));
const stA = await A.evaluate(() => ({ conns: [...window.__pr.conns.keys()], vids: document.querySelectorAll('video').length }));
const stB = await B.evaluate(() => ({ conns: [...window.__pr.conns.keys()], vids: document.querySelectorAll('video').length }));
console.log('A', JSON.stringify(stA), 'B', JSON.stringify(stB));
const pass = res.open > 0 && res.stream === 0 && res.data <= res.open && stA.conns.length === 1 && stB.conns.length === 1 && stA.vids === 2 && stB.vids === 2;
console.log(pass ? 'NEG PASS: no media, no slot, no content (outsider only gets each side sealed challenge, which it cannot answer)' : 'NEG FAIL');
await b.close(); srv && srv.close(); process.exit(pass ? 0 : 1);
