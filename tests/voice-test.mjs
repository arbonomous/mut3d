import { chromium } from 'playwright'; import http from 'http'; import fs from 'fs';
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('dist/index.html')); }).listen(8175);
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) fail++; };
const mk = async (u) => { const c = await b.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => console.log('ERR', e.message)); await p.goto(u); return p; };
const A = await mk('http://localhost:8175/'); await A.uncheck('#approve'); await A.click('#create'); const url = A.url(); await A.click('#mic'); await wait(2000);
const B = await mk(url); await B.click('#joinbtn'); await B.click('#mic'); await wait(14000);
// measure dominant frequency and level of remote audio on B over ~3s
const probe = () => B.evaluate(async () => {
  const v = [...document.querySelectorAll('figure')].find((f) => f.__local === false).querySelector('video');
  const ctx = new AudioContext(); await ctx.resume(); const an = ctx.createAnalyser(); an.fftSize = 8192; ctx.createMediaStreamSource(v.srcObject).connect(an);
  const buf = new Float32Array(an.frequencyBinCount); let best = 0, bf = 0, peak = -200;
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatFrequencyData(buf); for (let k = 2; k < buf.length; k++) { if (buf[k] > peak) { peak = buf[k]; bf = k * ctx.sampleRate / an.fftSize; } } }
  await ctx.close(); return { f: Math.round(bf), db: Math.round(peak) };
});
console.log('A local', await A.evaluate(() => [...document.querySelectorAll('video')].map(v => v.srcObject ? v.srcObject.getAudioTracks().length : -1))); console.log(await B.evaluate(() => [...document.querySelectorAll('video')].map(v => (v.srcObject ? v.srcObject.getAudioTracks().length + '/' + v.srcObject.getVideoTracks().length : 'none') + ' muted=' + v.muted)), await B.textContent('#status'));
const base = await probe(); console.log('base', base);
await A.click('#more'); await A.selectOption('#voice', 'deeper'); await wait(2500);
console.log('voiceErr', await A.evaluate(() => window.__pr.voiceErr), await A.evaluate(() => window.__pr.voice));
const deep = await probe(); console.log('deeper', deep);
ok('audio present', base.db > -80);
ok('deeper changes pitch down', deep.db > -90 && deep.f < base.f * 0.9);
await A.selectOption('#voice', 'higher'); await wait(2000); const hi = await probe(); console.log('higher', hi);
ok('higher changes pitch up', hi.f > base.f * 1.2);
await A.selectOption('#voice', 'robot'); await wait(2000); const rb = await probe(); console.log('robot', rb); ok('robot still audible', rb.db > -90);
await A.click('#mic'); await wait(1500); const mu = await probe(); console.log('muted', mu); ok('mute silences disguised voice', mu.db < -90);
await A.click('#mic'); await A.selectOption('#voice', 'off'); await wait(2000); const off = await probe(); console.log('off', off); ok('off restores', Math.abs(off.f - base.f) <= base.f * 0.1 + 20);
await b.close(); srv.close(); process.exit(fail ? 1 : 0);
