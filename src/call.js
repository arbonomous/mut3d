import { Peer } from 'peerjs';
import qrcode from 'qrcode-generator';

const APP_NAME = 'mut3d'; // working name, change here only
const VERSION = 'v17';
const $ = (s) => document.querySelector(s);
document.title = APP_NAME;
document.querySelectorAll('.appname').forEach((e) => { e.textContent = APP_NAME; });
const enc = new TextEncoder(), dec = new TextDecoder();
const MAX = 8;
const MAXFILE = 25 * 1024 * 1024;
const CHUNK = 16 * 1024;
const b64u = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));

let key, roomId, aes, local, screen, peer, me = -1, myName = '';
let hostPub = null, hostPriv = null, expiryMin = 0, startMin = 0, ended = false, brand = { n: '', c: -1, l: '' };
let approvalMode = false, isHost = false, selfOk = true;
const vouched = new Set(), knocks = new Map(), blobUrls = [];
const unhex = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const unb64 = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
// Link format: #KEY[.pHOSTPUBLIC][.eEXPIRYMINUTES][.sHOSTSECRET]. Only the host's own address bar has the s part.
function parseHash() {
  const parts = location.hash.slice(1).split('.');
  key = parts[0];
  for (const t of parts.slice(1)) {
    if (t[0] === 'p') hostPub = t.slice(1);
    else if (t[0] === 'e') expiryMin = parseInt(t.slice(1), 36) || 0;
    else if (t[0] === 's') hostPriv = t.slice(1);
    else if (t[0] === 't') startMin = parseInt(t.slice(1), 36) || 0;
    else if (t[0] === 'n') { try { brand.n = dec.decode(unb64(t.slice(1))).slice(0, 24); } catch (e) { /* ignore */ } }
    else if (t[0] === 'c') brand.c = parseInt(t.slice(1), 10);
    else if (t[0] === 'l' && /^[A-Za-z0-9_-]{20,3200}$/.test(t.slice(1))) brand.l = t.slice(1);
  }
  try { const k = 'mut3d-hs:' + key; if (hostPriv) sessionStorage.setItem(k, hostPriv); else if (hostPub) hostPriv = sessionStorage.getItem(k) || null; } catch (e) { /* storage blocked */ }
  if (hostPub && location.hash.includes('.s')) history.replaceState(null, '', inviteLink());
  approvalMode = !!hostPub; isHost = !!(hostPub && hostPriv); selfOk = !approvalMode || isHost;
}
function inviteLink() {
  const parts = [key]; if (hostPub) parts.push('p' + hostPub); if (expiryMin) parts.push('e' + expiryMin.toString(36)); if (startMin) parts.push('t' + startMin.toString(36)); if (brand.n) parts.push('n' + b64u(enc.encode(brand.n))); if (brand.c >= 0) parts.push('c' + brand.c); if (brand.l) parts.push('l' + brand.l);
  return location.origin + location.pathname + '#' + parts.join('.');
}
async function hostKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { pub: b64u(new Uint8Array([...unb64(j.x), ...unb64(j.y)])), priv: b64u(unb64(j.d)) };
}
async function hostSign(msg) {
  const raw = unb64(hostPub); const jwk = { kty: 'EC', crv: 'P-256', x: b64u(raw.slice(0, 32)), y: b64u(raw.slice(32)), d: hostPriv, ext: true };
  const k = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, enc.encode(msg)));
}
async function hostVerify(sig, msg) {
  try {
    const raw = unb64(hostPub); const jwk = { kty: 'EC', crv: 'P-256', x: b64u(raw.slice(0, 32)), y: b64u(raw.slice(32)), ext: true };
    const k = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, enc.encode(msg));
  } catch (e) { return false; }
}
const conns = new Map(), calls = new Map(), tiles = new Map(), info = new Map(), pending = new Map(), lastTry = new Map();
const stats = { sent: 0, recv: 0 };
const colors = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f'];
const state = { mic: true, cam: true };
window.__pr = { conns, calls, stats, Peer, info, forceSend: (type, o) => { for (const c of conns.values()) send(c, type, typeof o === 'string' ? enc.encode(o) : o); } };

window.addEventListener('error', (e) => { const x = document.getElementById('err'); if (x) { x.style.display = 'block'; x.textContent = 'Problem: ' + (e.message || e.error) + ' (' + (e.lineno || '') + ')'; } });
window.addEventListener('unhandledrejection', (e) => { const x = document.getElementById('err'); if (x) { x.style.display = 'block'; x.textContent = 'Problem: ' + (e.reason && e.reason.message || e.reason); } });
const status = (t) => { $('#status').textContent = t; };
const slotOf = (id) => +id.split('-').pop();
const nameOf = (s) => (info.get(s) && info.get(s).name) || 'Guest ' + (s + 1);

// Every message is bound to its type, its sender and its recipient through AES-GCM additional data.
const aadFor = (type, from, to) => new TextEncoder().encode(type + '|' + from + '|' + to);
const myId = () => roomId + '-' + me;
async function seal(type, u8, c) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(type, myId(), c.peer) }, aes, u8));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = type; out.set(iv, 1); out.set(ct, 13);
  return out;
}
async function open(d, c) {
  const u = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ? d.buffer : d);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(1, 13), additionalData: aadFor(u[0], c.peer, myId()) }, aes, u.slice(13)));
  return [u[0], pt];
}
async function send(c, type, u8) { if (!c.open) return; c.send(await seal(type, u8, c)); stats.sent++; }
// Chat, names and files go only to people who are fully let in (c.__started). Pings go to every proven connection.
function broadcast(type, u8, all) { for (const c of conns.values()) if (all || c.__started) send(c, type, u8); }
const json = (o) => enc.encode(JSON.stringify(o));
const metaObj = () => ({ name: myName, mic: state.mic, cam: state.cam, sharing: !!screen });
const sendMeta = () => broadcast(4, json(metaObj()));

function fakeStream(label) {
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
  const g = cv.getContext('2d'); let t = 0;
  setInterval(() => {
    g.fillStyle = '#1f2933'; g.fillRect(0, 0, 320, 240);
    g.fillStyle = colors[me >= 0 ? me % 4 : 0]; g.fillRect(20 + (t % 240), 150, 40, 40);
    g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(label + ' (test video)', 20, 60); t += 4;
  }, 66);
  return cv.captureStream(15);
}
function showMicHelp() {
  const b = $('#michelp'); if (!b) return; b.hidden = false;
  const ua = navigator.userAgent || '';
  const br = /CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : /EdgiOS/.test(ua) ? 'edge' : (/Safari/.test(ua) && /Version\//.test(ua) && /iPhone|iPad/.test(ua)) ? 'safari' : 'other';
  const open1 = '<li>Easiest: close this tab, open the invite link again, and tap <b>Allow</b> when it asks for the microphone.</li>';
  const inapp = '<li>Opened the link inside another app (Messages, Instagram, Gmail)? Open it in your browser instead, then try again.</li>';
  const S = {
    safari: ['Safari', open1 + '<li>Tap the <b>aA</b> icon in the address bar, then <b>Website Settings</b>, then <b>Microphone</b>, then <b>Allow</b>.</li><li>Or open the iPhone <b>Settings</b> app, tap <b>Apps</b>, then <b>Safari</b>, then <b>Microphone</b> and choose <b>Ask</b> or <b>Allow</b>.</li>' + inapp],
    chrome: ['Chrome', open1 + '<li>In Chrome, tap the <b>Microphone</b> icon left of the address bar (it shows only if the site was blocked before) and turn the permission on.</li><li>Or open the iPhone <b>Settings</b> app, tap <b>Apps</b>, then <b>Chrome</b>, and turn on <b>Microphone</b>.</li>' + inapp],
    firefox: ['Firefox', open1 + '<li>Open the iPhone <b>Settings</b> app, tap <b>Apps</b>, then <b>Firefox</b>, and turn on <b>Microphone</b>.</li>' + inapp],
    edge: ['Edge', open1 + '<li>Open the iPhone <b>Settings</b> app, tap <b>Apps</b>, then <b>Edge</b>, and turn on <b>Microphone</b>.</li>' + inapp],
    other: ['', open1 + '<li>Open the iPhone <b>Settings</b> app, tap <b>Apps</b>, then your browser (Safari, Chrome...), and allow <b>Microphone</b>. In Safari you can also tap <b>aA</b> in the address bar, then <b>Website Settings</b>, then <b>Microphone</b>.</li>' + inapp],
  }[br];
  $('#micwho').textContent = S[0] ? '(looks like ' + S[0] + ')' : '';
  $('#micsteps').innerHTML = S[1];
  $('#micretry').onclick = async () => {
    const m = $('#micmsg'); m.textContent = 'Checking...';
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); m.textContent = 'Microphone works. Reloading...'; setTimeout(() => location.reload(), 600); }
    catch (e) { m.textContent = 'Still blocked (' + ((e && e.name) || 'error') + '). Change the setting, then tap Retry again.'; }
  };
}
async function getStream(useCam) {
  if (useCam && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // Try nicer settings first, then plain ones: some Safari versions reject specific constraints.
    const tries = [
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } },
      { video: { facingMode: 'user' }, audio: true },
      { video: true, audio: true },
      { video: true, audio: false },
    ];
    for (const c of tries) { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { window.__pr.gumErr = e && e.name; } }
    try { const a = await navigator.mediaDevices.getUserMedia({ audio: true }); status('No camera found, audio only'); state.cam = false; return a; }
    catch (e2) { status('Camera/mic blocked (' + (window.__pr.gumErr || 'error') + '). Using a test picture.'); }
  } else if (useCam) status('This browser cannot use the camera here. Using a test picture.');
  state.mic = false; state.cam = false;
  return fakeStream('Guest');
}

function tile(slot) {
  let t = tiles.get(slot);
  if (!t) {
    const fig = document.createElement('figure');
    fig.innerHTML = '<video autoplay playsinline muted></video><div class="st" hidden></div><button type="button" class="tap" hidden></button><figcaption><span class="nm"></span><span class="ic"></span></figcaption>';
    fig.addEventListener('click', (e) => { if (e.target.closest('.tap')) return; enlarge(fig); }); $('#videos').appendChild(fig); t = fig; tiles.set(slot, t);
  }
  return t;
}
function paintTile(slot) {
  const t = tiles.get(slot); if (!t) return;
  const i = slot === me ? { name: myName || 'You', mic: state.mic, cam: state.cam, sharing: !!screen } : (info.get(slot) || {});
  t.querySelector('.nm').textContent = slot === me ? (myName || 'You') + ' (you)' : nameOf(slot);
  t.querySelector('.ic').textContent = (i.mic === false ? ' 🔇' : '') + (i.cam === false ? ' 📷off' : '') + (i.sharing ? ' 🖥' : '');
  t.classList.toggle('off', i.cam === false && !i.sharing);
  const n = tiles.size; $('#videos').dataset.n = n;
}
// ---- speaker highlight (local audio levels only) and tap-to-enlarge ----
let ac = null;
function level(box) {
  const st = box.__stream; if (!st) return 0;
  if (!box.__an) {
    if (!st.getAudioTracks().length) return 0;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(new MediaStream(st.getAudioTracks())).connect(an); box.__an = an; box.__buf = new Uint8Array(an.fftSize);
    } catch (e) { return 0; }
  }
  box.__an.getByteTimeDomainData(box.__buf); let m = 0; for (const b of box.__buf) m = Math.max(m, Math.abs(b - 128)); return m / 128;
}
setInterval(() => {
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
  let best = null, bl = 0.06; const lv = [];
  for (const [slot, box] of tiles) { const l = level(box); lv.push(l); if (l > bl) { bl = l; best = box; } }
  for (const box of tiles.values()) box.classList.toggle('talk', box === best && tiles.size > 1);
  window.__pr.levels = lv;
}, 250);
function enlarge(box) {
  const vs = $('#videos'); const was = box.classList.contains('big');
  for (const b of tiles.values()) b.classList.remove('big');
  if (!was && tiles.size > 1) { box.classList.add('big'); vs.classList.add('hasbig'); vs.style.setProperty('--k', String(Math.max(1, tiles.size - 1))); } else vs.classList.remove('hasbig');
}
function tryPlay(v, box) {
  const ov = box.querySelector('.tap');
  const p = v.play();
  if (p && p.catch) p.catch(() => {
    // Browser blocked sound or autoplay. Retry muted so the picture at least shows, and offer a tap to start sound.
    if (!v.muted) { v.muted = true; v.play().then(() => { ov.textContent = 'Tap for sound'; ov.classList.remove('big'); ov.hidden = false; }).catch(() => { ov.textContent = 'Tap to start video'; ov.classList.add('big'); ov.hidden = false; }); }
    else { ov.textContent = 'Tap to start video'; ov.classList.add('big'); ov.hidden = false; }
  });
}
function addVideo(slot, stream, isLocal) {
  const box = tile(slot); const v = box.querySelector('video');
  v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.playsInline = true;
  v.srcObject = stream; v.muted = !!isLocal; v.style.borderColor = colors[slot % 4]; box.__stream = stream; box.__local = !!isLocal;
  const ov = box.querySelector('.tap');
  ov.onclick = () => { v.muted = !!isLocal; ov.hidden = true; v.play().catch(() => { ov.hidden = false; }); };
  stream.onaddtrack = () => { v.srcObject = stream; tryPlay(v, box); };
  v.onloadedmetadata = () => tryPlay(v, box);
  setTimeout(() => { if (v.paused) tryPlay(v, box); }, 1500);
  paintTile(slot); tryPlay(v, box);
}
// Per-tile health: shows what is wrong instead of a silent black box.
function health() {
  for (const [slot, box] of tiles) {
    const v = box.querySelector('video'), st = box.querySelector('.st'); if (!v || !st) continue;
    let msg = '';
    if (slot !== me) {
      const call = calls.get(slot), pc = call && call.peerConnection;
      const ice = pc ? pc.iceConnectionState : 'new';
      const vt = box.__stream && box.__stream.getVideoTracks().length;
      const camOff = info.get(slot) && info.get(slot).cam === false;
      if (ice === 'failed') msg = "Couldn't connect video on this network. Try Wi-Fi on both phones.";
      else if (ice === 'checking' || ice === 'new') msg = 'Connecting...';
      else if (ice === 'disconnected') msg = 'Connection dropped, retrying...';
      else if (!camOff && (!vt || v.videoWidth === 0) && !v.paused) msg = 'Waiting for their video...';
    } else if (!box.__local || v.videoWidth === 0) msg = v.paused ? '' : 'Starting your camera...';
    if (!v.paused && v.videoWidth > 0) msg = msg && slot !== me ? msg : '';
    st.textContent = msg; st.hidden = !msg;
    if (v.paused && v.srcObject && box.querySelector('.tap').hidden) tryPlay(v, box);
  }
}
function dropVideo(slot) { const b = tiles.get(slot); if (b) { const was = b.classList.contains('big'); b.remove(); tiles.delete(slot); if (was || tiles.size < 2) { $('#videos').classList.remove('hasbig'); for (const x of tiles.values()) x.classList.remove('big'); } else $('#videos').style.setProperty('--k', String(Math.max(1, tiles.size - 1))); } info.delete(slot); calls.delete(slot); $('#videos').dataset.n = tiles.size; }

function tryAnswer(s) {
  const call = pending.get(s), c = conns.get(s);
  if (!call || !c || !c.__authed || !c.__ok || call.peer !== c.peer) return;
  pending.delete(s);
  call.answer(currentOut());
  watchCall(s, call);
}
const vidTracks = () => (face.on && face.track ? [face.track] : local.getVideoTracks());
const currentOut = () => (voice.track || face.on ? new MediaStream([...(voice.track ? [voice.track] : local.getAudioTracks()), ...vidTracks()]) : local);
// ---- face disguise: draws the outgoing camera onto a small canvas with an effect, in this browser. Off = the untouched camera. ----
// Not face-tracked: these cover or blur the whole picture. Capped at 480px wide and 15 fps to save battery.
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const face = { on: false, preset: 'off', track: null, cv: null, vid: null, timer: null, tiny: null };
const GREEN = '#B9F27C', INK = '#131A17';
function mpLoad() {
  if (face.lm) return Promise.resolve(face.lm);
  if (face.loading) return face.loading;
  window.__pr.mp = 'loading';
  const base = '/mp/';
  face.loading = import(/* @vite-ignore */ base + 'vision_bundle.mjs').then(async (mod) => {
    const fs = await mod.FilesetResolver.forVisionTasks(base + 'wasm');
    // CPU (wasm) on purpose: the GPU path is flaky on phones. Detection runs at about 10 per second.
    face.lm = await mod.FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true });
    window.__pr.mp = 'ready'; return face.lm;
  }).catch((e) => { window.__pr.mp = 'failed:' + (e && e.message); face.loading = null; throw e; });
  return face.loading;
}
// Background blur: a small person-cutout model (about 250 KB) runs in this browser. Only the background is blurred; your face stays visible.
function segLoad() {
  if (face.seg) return Promise.resolve(face.seg);
  if (face.segLoading) return face.segLoading;
  const base = '/mp/';
  face.segLoading = import(/* @vite-ignore */ base + 'vision_bundle.mjs').then(async (mod) => {
    const fs = await mod.FilesetResolver.forVisionTasks(base + 'wasm');
    face.seg = await mod.ImageSegmenter.createFromOptions(fs, { baseOptions: { modelAssetPath: base + 'selfie_segmenter.tflite', delegate: 'CPU' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    window.__pr.seg = 'ready'; return face.seg;
  }).catch((e) => { window.__pr.seg = 'failed:' + (e && e.message); face.segLoading = null; throw e; });
  return face.segLoading;
}
function segment(v) {
  const now = performance.now();
  if (!face.seg || now - (face.lastSeg || 0) < 90) return;
  face.lastSeg = now;
  try {
    face.seg.segmentForVideo(v, now, (res) => {
      const m = res.confidenceMasks && res.confidenceMasks[0]; if (!m) return;
      const a = m.getAsFloat32Array(), w = m.width, h = m.height;
      if (!face.mc) face.mc = document.createElement('canvas');
      if (face.mc.width !== w || face.mc.height !== h) { face.mc.width = w; face.mc.height = h; }
      const cx = face.mc.getContext('2d'), id = cx.createImageData(w, h), d = id.data;
      for (let i = 0; i < a.length; i++) { const p = a[i]; d[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(p * 255))); }
      cx.putImageData(id, 0, 0); face.segAt = now; window.__pr.segSeen = true;
    });
  } catch (e) { window.__pr.segErr = String(e && e.message); }
}
function detect(v) {
  const now = performance.now();
  if (!face.lm || now - (face.lastDet || 0) < 100) return;
  face.lastDet = now;
  try {
    const r = face.lm.detectForVideo(v, now);
    if (r && r.faceLandmarks && r.faceLandmarks[0]) {
      const bs = {}; const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories; if (cats) for (const c of cats) bs[c.categoryName] = c.score;
      face.res = { L: r.faceLandmarks[0], bs, at: now };
    } else if (face.res && now - face.res.at > 600) face.res = null;
    window.__pr.faceSeen = !!face.res;
  } catch (e) { window.__pr.mpErr = String(e && e.message); }
}
function drawAvatar(x, w, h, mask) {
  const r = face.res; if (!r) return false;
  const L = r.L, P = (i) => ({ x: L[i].x * w, y: L[i].y * h });
  const xs = [], ys = []; for (const c of FACE_OVAL) { xs.push(L[c].x * w); ys.push(L[c].y * h); }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, fw = x1 - x0, fh = y1 - y0;
  const a = P(33), c = P(263), roll = Math.atan2(c.y - a.y, c.x - a.x);
  const bs = r.bs || {}; const blink = (k) => Math.min(1, (bs[k] || 0) * 1.6);
  x.save(); x.translate(cx, cy); x.rotate(roll);
  const rx = fw * 0.56, ry = fh * 0.58;
  x.fillStyle = GREEN; x.beginPath(); x.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); x.fill();
  const toLocal = (pt) => { const dx = pt.x - cx, dy = pt.y - cy, cs = Math.cos(-roll), sn = Math.sin(-roll); return { x: dx * cs - dy * sn, y: dx * sn + dy * cs }; };
  const mid = (i, j) => { const p1 = P(i), p2 = P(j); return toLocal({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }); };
  const eyes = [[mid(33, 133), blink('eyeBlinkLeft')], [mid(362, 263), blink('eyeBlinkRight')]];
  x.fillStyle = INK;
  for (const [e, bl] of eyes) {
    if (mask) { x.fillRect(e.x - fw * 0.1, e.y - fh * 0.015, fw * 0.2, Math.max(fh * 0.012, fh * 0.03 * (1 - bl))); }
    else { x.beginPath(); x.ellipse(e.x, e.y, fw * 0.085, Math.max(fh * 0.01, fh * 0.07 * (1 - bl)), 0, 0, Math.PI * 2); x.fill(); }
  }
  const m = mid(61, 291), mw = Math.hypot(P(61).x - P(291).x, P(61).y - P(291).y), open = Math.min(1, (bs.jawOpen || 0) * 1.5);
  if (mask) { x.fillRect(m.x - mw * 0.35, m.y - fh * 0.008, mw * 0.7, fh * 0.016 + open * fh * 0.1); }
  else { x.beginPath(); x.ellipse(m.x, m.y + open * fh * 0.04, mw * 0.32, fh * 0.014 + open * fh * 0.09, 0, 0, Math.PI * 2); x.fill(); }
  x.restore(); return true;
}
function faceDraw() {
  const v = face.vid, cv = face.cv; if (!v || !v.videoWidth || !state.cam) return;
  const w = Math.min(480, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const x = cv.getContext('2d'), t = face.tiny, tx = t.getContext('2d');
  const down = (tw, th, smooth) => { t.width = tw; t.height = th; tx.imageSmoothingEnabled = smooth; tx.drawImage(v, 0, 0, tw, th); };
  const p = face.preset;
  const pix = (n, smooth) => { down(n, Math.max(2, Math.round(n * h / w)), smooth); x.imageSmoothingEnabled = smooth; if (smooth) x.imageSmoothingQuality = 'high'; x.drawImage(t, 0, 0, w, h); };
  if (p === 'pixel') pix(24, false);
  else if (p === 'bgblur') {
    segment(v); pix(36, true);
    if (face.mc && performance.now() - face.segAt < 1500) {
      if (!face.pc) face.pc = document.createElement('canvas'); const pc = face.pc; if (pc.width !== w || pc.height !== h) { pc.width = w; pc.height = h; }
      const px = pc.getContext('2d'); px.globalCompositeOperation = 'source-over'; px.clearRect(0, 0, w, h); px.drawImage(v, 0, 0, w, h);
      px.globalCompositeOperation = 'destination-in'; px.imageSmoothingEnabled = true; px.drawImage(face.mc, 0, 0, w, h); px.globalCompositeOperation = 'source-over';
      x.drawImage(pc, 0, 0);
    }
  }
  else if (p === 'avatar' || p === 'mask') {
    detect(v);
    if (p === 'avatar') { x.fillStyle = INK; x.fillRect(0, 0, w, h); } else pix(20, false);
    // Until the face is found, show only the coarse blur/pixels or a plain card, never the raw camera.
    if (!drawAvatar(x, w, h, p === 'mask') && p === 'avatar') { x.fillStyle = GREEN; x.font = Math.round(h * 0.07) + 'px system-ui,sans-serif'; x.textAlign = 'center'; x.fillText(face.lm ? 'looking for your face...' : 'loading face tracking...', w / 2, h / 2); }
  } else pix(16, true);
}
function faceSwapTo(track) {
  const box = tile(me); const vv = box && box.querySelector('video');
  if (!screen) { swapVideo(track); if (vv) vv.srcObject = face.on ? new MediaStream([face.track]) : local; }
}
function setFace(p) {
  const sel = $('#face');
  try {
    if (p === 'off') {
      face.on = false; face.preset = 'off'; clearInterval(face.timer); face.timer = null;
      faceSwapTo(local.getVideoTracks()[0]); window.__pr.face = 'off'; return;
    }
    const raw = local.getVideoTracks()[0];
    if (!raw || !state.cam && !face.track) { if (sel) sel.value = 'off'; sysMsg('Turn your camera on first to use a face effect.'); return; }
    if (!face.cv) {
      face.cv = window.__pr.faceCanvas = document.createElement('canvas'); face.tiny = document.createElement('canvas');
      if (!face.cv.captureStream) throw new Error('no captureStream');
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true; v.setAttribute('playsinline', ''); v.srcObject = new MediaStream([raw]);
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'; document.body.appendChild(v); v.play().catch(() => {}); face.vid = v;
      face.cv.width = 480; face.cv.height = 360;
      face.track = face.cv.captureStream(15).getVideoTracks()[0];
    }
    face.preset = p; face.on = true; face.track.enabled = state.cam;
    if (p === 'bgblur') { if (!face.seg) sysMsg('Loading background blur (about 13 MB, once). Until it is ready the whole picture is blurred, never your raw camera.'); segLoad().catch(() => { sysMsg('Background blur could not load. The whole picture stays blurred; pick another effect.'); }); }
    if (p === 'mask' || p === 'avatar') { if (!face.lm) sysMsg('Loading face tracking (about 17 MB, once). Until it is ready you see a blur, never your raw camera.'); mpLoad().catch(() => { sysMsg('Face tracking could not load here, so I switched you to Pixelate.'); if (face.preset === p) { if (sel) sel.value = 'pixel'; face.preset = 'pixel'; } }); }
    if (!face.timer) face.timer = setInterval(faceDraw, 66);
    faceDraw(); faceSwapTo(face.track); window.__pr.face = p;
    sysMsg(p === 'bgblur' ? 'Background blur on. Your face stays visible; only what is behind you is blurred.' : 'Face effect on. It hides your face, not you: your voice, background and room can still identify you.');
  } catch (e) { face.on = false; face.preset = 'off'; clearInterval(face.timer); face.timer = null; if (sel) sel.value = 'off'; sysMsg('Face effects are not available in this browser.'); window.__pr.faceErr = String(e && e.message); }
}
// ---- voice disguise: processes only the outgoing mic, in this browser. Off by default. ----
const voice = { ctx: null, track: null, node: null, src: null, mon: null, preset: 'off', hear: false };
const WORKLET = 'class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(8192);this.w=0;this.ph=0;this.r=1;this.port.onmessage=e=>{this.r=e.data}}process(i,o){const x=i[0]&&i[0][0],y=o[0][0];if(!x||!y)return true;const W=1536,N=8192,b=this.b;for(let k=0;k<x.length;k++){b[this.w]=x[k];let out=0;for(let h=0;h<2;h++){const p=(this.ph+h*0.5)%1;let rp=this.w-(p*W+1);if(rp<0)rp+=N;const i0=Math.floor(rp),f=rp-i0,s=b[i0]*(1-f)+b[(i0+1)%N]*f,g=Math.sin(Math.PI*p);out+=s*g*g}y[k]=out;this.w=(this.w+1)%N;this.ph+=(1-this.r)/W;if(this.ph>=1)this.ph-=1;if(this.ph<0)this.ph+=1}return true}}registerProcessor("p",P)';
const RATIO = { deeper: 0.72, higher: 1.45 };
async function voiceInit() {
  if (voice.ctx) { if (voice.ctx.state === 'suspended') await voice.ctx.resume().catch(() => {}); return; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) throw new Error('no AudioContext');
  const mic = local.getAudioTracks()[0]; if (!mic) throw new Error('no mic');
  const ctx = new AC({ latencyHint: 'interactive' }); await ctx.resume().catch(() => {});
  if (!ctx.audioWorklet) throw new Error('no worklet');
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const src = ctx.createMediaStreamSource(new MediaStream([mic]));
  const node = new AudioWorkletNode(ctx, 'p');
  const ring = ctx.createGain(); const osc = ctx.createOscillator(); osc.frequency.value = 55; const ringDepth = ctx.createGain(); ringDepth.gain.value = 0; osc.connect(ring.gain); osc.start();
  const dry = ctx.createGain(); const wet = ctx.createGain(); const robot = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  const mon = ctx.createGain(); mon.gain.value = 0; mon.connect(ctx.destination);
  const out = ctx.createGain(); out.connect(dest); out.connect(mon);
  src.connect(dry); dry.connect(out);
  src.connect(node); node.connect(wet); wet.connect(out);
  src.connect(ring); ring.gain.value = 0; ring.connect(robot); robot.connect(out);
  Object.assign(voice, { ctx, src, node, dry, wet, robot, mon, out, dest, osc });
  voice.track = dest.stream.getAudioTracks()[0]; voice.track.enabled = state.mic;
}
function voiceApply() {
  const p = voice.preset;
  voice.dry.gain.value = p === 'off' ? 1 : 0; voice.wet.gain.value = RATIO[p] ? 1 : 0; voice.robot.gain.value = p === 'robot' ? 1.4 : 0;
  voice.node.port.postMessage(RATIO[p] || 1); voice.mon.gain.value = voice.hear && p !== 'off' ? 1 : 0;
}
function voiceSwap(track) {
  for (const call of calls.values()) {
    const pc = call.peerConnection; if (!pc) continue;
    const snd = pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
    if (snd && track) snd.replaceTrack(track).catch(() => {});
  }
}
async function setVoice(p) {
  const sel = $('#voice');
  try {
    if (p !== 'off' || voice.ctx) await voiceInit();
    voice.preset = p; voice.ctx ? voiceApply() : 0;
    if (voice.track) voiceSwap(p === 'off' ? local.getAudioTracks()[0] : voice.track);
    if (p === 'off' && voice.track) voice.track.enabled = state.mic;
    if (p !== 'off') voice.track.enabled = state.mic;
    window.__pr.voice = p;
    if (p !== 'off') sysMsg('Voice effect on. It disguises how you sound; it does not make you anonymous.');
  } catch (e) { voice.preset = 'off'; if (sel) sel.value = 'off'; sysMsg('Voice effects are not available in this browser.'); window.__pr.voiceErr = String(e && e.message); }
}
function watchCall(s, call) {
  calls.set(s, call);
  call.on('stream', (st) => addVideo(s, st, false));
  call.on('close', () => { if (calls.get(s) === call) calls.delete(s); });
}

// ---- chat ----
function addMsg(who, text, mine, slot) {
  const d = document.createElement('div'); d.className = 'msg' + (mine ? ' mine' : '');
  const b = document.createElement('b'); b.textContent = who + ' '; b.style.color = colors[(slot || 0) % 4];
  const s = document.createElement('span'); s.textContent = text;
  d.append(b, s); const l = $('#log'); l.appendChild(d); l.scrollTop = l.scrollHeight;
  if (!mine && $('#chatpanel').hidden) $('#chatbtn').classList.add('ping');
}
function sysMsg(text) { const d = document.createElement('div'); d.className = 'sys'; d.textContent = text; $('#log').appendChild(d); $('#log').scrollTop = 1e9; }

// ---- files ----
const incoming = new Map();
const fid = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => x.toString(16).padStart(2, '0')).join('');
function fileRow(who, name, size) {
  const d = document.createElement('div'); d.className = 'msg file';
  d.textContent = who + ': ' + name + ' (' + Math.ceil(size / 1024) + ' KB) ';
  const st = document.createElement('span'); st.textContent = '0%'; d.appendChild(st);
  $('#log').appendChild(d); $('#log').scrollTop = 1e9; if ($('#chatpanel').hidden) $('#chatbtn').classList.add('ping'); return { d, st };
}
async function sendFile(file) {
  if (![...conns.values()].some((c) => c.__started)) { sysMsg('Nobody else is here yet.'); return; }
  if (file.size > MAXFILE) { sysMsg('File too big (limit 25 MB).'); return; }
  const id = fid(); const row = fileRow('You sent', file.name, file.size);
  broadcast(5, json({ id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
  const buf = new Uint8Array(await file.arrayBuffer());
  const idb = enc.encode(id);
  for (let off = 0; off < buf.length || off === 0; off += CHUNK) {
    const part = buf.subarray(off, off + CHUNK); const m = new Uint8Array(8 + part.length); m.set(idb); m.set(part, 8);
    for (const c of conns.values()) {
      if (!c.__started) continue;
      while (c.open && c.dataChannel && c.dataChannel.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 30));
      await send(c, 6, m);
    }
    row.st.textContent = Math.min(100, Math.round(((off + CHUNK) / Math.max(1, buf.length)) * 100)) + '%';
    if (!buf.length) break;
  }
  row.st.textContent = 'sent';
}
function onFileMeta(s, m) {
  if (!m || typeof m.id !== 'string' || m.id.length !== 8 || !(m.size >= 0) || m.size > MAXFILE) return;
  const k = s + ':' + m.id; if (incoming.has(k)) return;
  const row = fileRow(nameOf(s) + ' sends', String(m.name).slice(0, 100), m.size);
  incoming.set(k, { m, parts: [], got: 0, row });
}
function onFileChunk(s, pt) {
  const id = dec.decode(pt.slice(0, 8)); const k = s + ':' + id; const f = incoming.get(k); if (!f) return;
  const part = pt.slice(8); f.got += part.length;
  if (f.got > f.m.size) { incoming.delete(k); f.row.st.textContent = 'rejected'; return; }
  f.parts.push(part); f.row.st.textContent = Math.round((f.got / Math.max(1, f.m.size)) * 100) + '%';
  if (f.got >= f.m.size) {
    incoming.delete(k);
    const url = URL.createObjectURL(new Blob(f.parts, { type: 'application/octet-stream' })); blobUrls.push(url);
    const a = document.createElement('a'); a.href = url; a.download = String(f.m.name).replace(/[\\/]/g, '_').slice(0, 100); a.textContent = 'Save file';
    f.row.st.textContent = ''; f.row.d.appendChild(a);
  }
}

function ready(c) {
  if (c.__started || !c.__ok || !c.__peerOk || !c.open) return;
  c.__started = true;
  send(c, 4, json(metaObj()));
  if (c.__outgoing && peer) watchCall(c.__slot, peer.call(c.peer, currentOut()));
  tryAnswer(c.__slot);
  sysMsg(nameOf(c.__slot) + ' joined');
}
function markOk(c) { if (c.__ok) return; c.__ok = true; c.__okAt = Date.now(); send(c, 13, new Uint8Array(1)); ready(c); }
// ---- theme: stored only as the words dark or light on this device ----
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('mut3d-theme', t); } catch (e) { /* private mode */ } const b = $('#theme'); if (b) b.textContent = t === 'light' ? 'Dark theme' : 'Light theme'; const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'light' ? '#F5F8F2' : '#131A17'; window.__pr.theme = t; }
(function () { let t = 'dark'; try { t = localStorage.getItem('mut3d-theme') || 'dark'; } catch (e) { /* ignore */ } document.documentElement.setAttribute('data-theme', t); const wire = () => { const b = $('#theme'); if (b) { b.textContent = t === 'light' ? 'Dark theme' : 'Light theme'; b.onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'); } window.__pr.theme = t; }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire(); })();
// ---- invite: share sheet, QR, optional short link ----
// The room key lives after the # and never reaches a server. A short link keeps that true: the full link is encrypted in this browser
// with a random 12-letter code that stays after the # of the short link, so our server only stores ciphertext for 24 hours.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const rndStr = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => B32[x % 32]).join('');
async function pbKey(pass, salt) { const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function sealLink(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pbKey(pass, salt), enc.encode(text)));
  const out = new Uint8Array(28 + ct.length); out.set(salt, 0); out.set(iv, 16); out.set(ct, 28); return b64u(out);
}
async function openLink(c, pass) { const raw = unb64(c); return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, await pbKey(pass, raw.slice(0, 16)), raw.slice(28))); }
async function makeShort() {
  const pass = rndStr(12), full = inviteLink().split('#')[1];
  const r = await fetch('/s', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ c: await sealLink(full, pass) }) });
  if (!r.ok) throw new Error('short ' + r.status);
  return location.origin + '/s/' + (await r.json()).id + '#' + pass;
}
async function resolveShort() {
  const m = location.pathname.match(/^\/s\/([a-z2-7]{6,16})$/); if (!m) return;
  const pass = location.hash.slice(1);
  try {
    const r = await fetch('/s/' + m[1] + '?j=1', { cache: 'no-store' }); if (!r.ok) throw new Error('gone');
    history.replaceState(null, '', '/#' + await openLink((await r.json()).c, pass));
  } catch (e) { history.replaceState(null, '', '/'); window.__pr.shortErr = String(e && e.message); const n = document.querySelector('#shortgone'); if (n) n.hidden = false; }
}
function drawQr(text) {
  const cv = $('#qr'); cv.hidden = false; const q = qrcode(0, 'L'); try { q.addData(text); q.make(); } catch (e) { cv.hidden = true; window.__pr.qrErr = true; return; }
  const n = q.getModuleCount(), sc = Math.max(3, Math.floor(280 / (n + 8))), size = (n + 8) * sc; cv.width = cv.height = size;
  const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, size, size); x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect((c + 4) * sc, (r + 4) * sc, sc, sc);
  window.__pr.qrModules = n;
}
let inviteUrl = '';
function openInvite() {
  if (me < 0) parseHash();
  inviteUrl = inviteLink(); $('#invurl').textContent = inviteUrl.length > 60 ? inviteUrl.slice(0, 28) + '...' + inviteUrl.slice(-14) : inviteUrl;
  $('#invshare').hidden = !navigator.share; $('#invnote').textContent = approvalMode ? 'People who open this link ask to join and you let them in.' : 'Anyone with this link can join, so send it only to people you trust.';
  $('#invshortnote').hidden = true; $('#invics').hidden = !startMin; drawQr(inviteUrl); $('#invite').hidden = false;
}
async function copyText(t, btn, label) { try { await navigator.clipboard.writeText(t); } catch (e) { /* no clipboard */ } const o = btn.textContent; btn.textContent = label; setTimeout(() => { btn.textContent = o; }, 2000); }
// ---- room lock (host only) ----
let locked = false, lockedSeen = false;
function setLock(v) {
  locked = v; $('#lock').textContent = locked ? 'Unlock room' : 'Lock room';
  if (locked) for (const k of [...knocks.keys()]) denyGuest(k, true);
  broadcast(14, json({ locked })); updateMode();
}
function renderBulk() {
  let b = $('#bulk');
  if (knocks.size > 1 && isHost) {
    if (!b) { b = document.createElement('div'); b.id = 'bulk'; b.className = 'knock'; const y = document.createElement('button'); y.textContent = 'Let everyone in'; const n = document.createElement('button'); n.textContent = 'Deny all'; n.className = 'alt'; b.append(y, n); $('#knocks').prepend(b); y.onclick = () => { for (const k of [...knocks.keys()]) admitGuest(k); }; n.onclick = () => { for (const k of [...knocks.keys()]) denyGuest(k); }; }
  } else if (b) b.remove();
}
function showKnock(s, name) {
  if (knocks.has(s)) return;
  const row = document.createElement('div'); row.className = 'knock';
  const t = document.createElement('span'); t.textContent = (name || 'Someone') + ' wants to join';
  const y = document.createElement('button'); y.textContent = 'Let in'; const n = document.createElement('button'); n.textContent = 'Deny'; n.className = 'alt';
  row.append(t, y, n); $('#knocks').appendChild(row); knocks.set(s, row); renderBulk(); alertKnock();
  y.onclick = () => admitGuest(s); n.onclick = () => denyGuest(s);
}
function updateMode() {
  const m = $('#mode'); if (!m) return;
  m.textContent = (approvalMode ? (isHost ? 'You are the host. Approval on' : 'Approval on') : 'Open room: anyone with the link joins') + (knocks.size ? ' - ' + knocks.size + ' waiting to join' : '') + ((locked || lockedSeen) ? ' - room locked' : '') + (window.__pr.oldPeer ? ' - a friend may be on an old version, refresh both phones' : '') + ' (' + VERSION + ')';
}
function alertKnock() { updateMode(); try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* no vibration */ } document.title = '(' + knocks.size + ') Someone wants to join'; }
function clearKnock(s) { const r = knocks.get(s); if (r) { r.remove(); knocks.delete(s); } renderBulk(); document.title = knocks.size ? '(' + knocks.size + ') Someone wants to join' : APP_NAME; updateMode(); }
async function sendProof(c) { if (isHost && c.__peerNonce && c.open) await send(c, 9, await hostSign('host|' + myId() + '|' + c.peer + '|' + hex(c.__peerNonce))); }
function admitGuest(s) {
  const c = conns.get(s); clearKnock(s); if (!c || !c.__authed || !isHost) return;
  sendProof(c);
  const members = [...conns.values()].filter((x) => x.__ok && x !== c).map((x) => slotOf(x.peer));
  send(c, 11, json({ self: true, members }));
  for (const x of conns.values()) if (x !== c && x.__ok) send(x, 11, json({ slot: s, ok: true }));
  markOk(c);
}
function denyGuest(s, lk) { const c = conns.get(s); clearKnock(s); if (!c) return; send(c, 11, json(lk ? { deny: true, locked: true } : { deny: true })); setTimeout(() => c.close(), 400); }
function onSelfApproved(msg, hostConn) {
  selfOk = true; $('#wait').hidden = true; status('In the call');
  (msg.members || []).forEach((m) => vouched.add(+m));
  for (const x of conns.values()) if (x.__authed && vouched.has(slotOf(x.peer))) markOk(x);
  markOk(hostConn);
}
function onConn(c, outgoing) {
  const s = slotOf(c.peer);
  if (!c.peer.startsWith(roomId + '-') || !(s >= 0 && s < MAX) || s === me) { c.close(); return; }
  const initiator = () => (outgoing ? me : s);
  c.__authed = false; c.__ok = false; c.__peerOk = false; c.__started = false; c.__host = false; c.__outgoing = outgoing; c.__slot = s;
  c.__nonce = crypto.getRandomValues(new Uint8Array(16));
  // Admission: nothing is shared and no media flows until the other side proves it holds the room key.
  const timer = setTimeout(() => { if (!c.__authed) c.close(); }, 8000);
  const admit = async () => {
    clearTimeout(timer);
    const ex = conns.get(s);
    if (ex && ex !== c && ex.open) {
      if (ex.__init < initiator()) { c.close(); return; }
      conns.delete(s); ex.close();
    }
    c.__authed = true; c.__init = initiator(); c.__last = Date.now();
    conns.set(s, c);
    if (!approvalMode) { markOk(c); return; }
    // Host approval mode: the host proves who it is with a signature over this connection's fresh challenge.
    if (isHost) await sendProof(c);
    else send(c, 10, json({ name: myName }));
    if (vouched.has(s) && selfOk) markOk(c);
  };
  const hello = async () => c.send(await seal(2, c.__nonce, c));
  c.on('open', hello);
  if (c.open) hello();
  c.on('data', async (d) => {
    try {
      const [type, pt] = await open(d, c);
      if (type === 2) { c.__peerNonce = pt; c.send(await seal(3, pt, c)); if (c.__authed && isHost) sendProof(c); return; }
      if (type === 3) {
        if (c.__authed) return;
        if (pt.length === 16 && pt.every((x, i) => x === c.__nonce[i])) await admit();
        return;
      }
      if (!c.__authed) return;
      stats.recv++; c.__last = Date.now();
      if (type === 7) return;
      if (type === 9) { // host proof
        if (approvalMode && !isHost && await hostVerify(pt, 'host|' + c.peer + '|' + myId() + '|' + hex(c.__nonce))) { c.__host = true; if (selfOk) markOk(c); }
        return;
      }
      if (type === 10) { if (isHost && !c.__ok && locked) { send(c, 11, json({ deny: true, locked: true })); setTimeout(() => c.close(), 400); return; } if (isHost && !c.__ok) { sendProof(c); showKnock(s, String(JSON.parse(dec.decode(pt)).name || '').slice(0, 24) || 'Guest ' + (s + 1)); } return; }
      if (type === 11) { // only a proven host may approve people
        if (!c.__host) return;
        const m = JSON.parse(dec.decode(pt));
        if (m.deny) { wipe(m.locked ? 'This room is locked by the host right now.' : 'The host did not let you in.'); return; }
        if (m.self) { onSelfApproved(m, c); return; }
        if (typeof m.slot === 'number') {
          if (m.ok) { vouched.add(m.slot); const x = conns.get(m.slot); if (selfOk && x && x.__authed) markOk(x); } else vouched.delete(m.slot);
        }
        return;
      }
      if (type === 14) { if (c.__host) { lockedSeen = !!JSON.parse(dec.decode(pt)).locked; updateMode(); } return; }
      if (type === 13) { c.__peerOk = true; ready(c); return; }
      if (type === 8) { // end the room for everyone
        if (c.__ok && (!approvalMode || c.__host)) wipe('The room was ended by ' + (approvalMode ? 'the host' : nameOf(s)) + '. Chat and files were cleared from this tab.');
        return;
      }
      if (!c.__ok) return; // not let in: nothing below is accepted
      if (type === 0) { const m = JSON.parse(dec.decode(pt)); addMsg(nameOf(s), String(m.t).slice(0, 2000), false, s); }
      else if (type === 4) { const m = JSON.parse(dec.decode(pt)); info.set(s, { name: String(m.name || '').slice(0, 24) || 'Guest ' + (s + 1), mic: m.mic !== false, cam: m.cam !== false, sharing: !!m.sharing }); paintTile(s); }
      else if (type === 5) onFileMeta(s, JSON.parse(dec.decode(pt)));
      else if (type === 6) onFileChunk(s, pt);
    } catch (e) { console.warn('bad message dropped'); }
  });
  c.on('close', () => {
    clearTimeout(timer); clearKnock(s);
    if (conns.get(s) === c) { conns.delete(s); vouched.delete(s); const n = nameOf(s); dropVideo(s); if (c.__started) sysMsg(n + ' left'); }
  });
}

let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
// Relay (TURN) is a fallback only: the browser still tries a direct path first. Short-lived credentials come from our own server.
function loadIce() {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 2500);
  return fetch('/turn', { signal: ac.signal, cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((j) => {
    if (j && j.busy) window.__pr.relayBusy = true;
    if (j && Array.isArray(j.iceServers) && j.iceServers.length) { iceServers = iceServers.concat(j.iceServers); window.__pr.relay = true; }
  }).catch(() => {}).then(() => clearTimeout(tm));
}
function register(slot) {
  if (slot >= MAX) {
    window.__pr.fullTries = (window.__pr.fullTries || 0) + 1;
    if (window.__pr.fullTries > 12) { status('Room is full (8 people max).'); return; }
    status('Room looks full. If you just refreshed, waiting a few seconds for your old spot to free up...');
    setTimeout(() => register(0), 6000); return;
  }
  const sg = window.__pr.sig = window.__pr.sig || { tries: 0, err: '', t0: Date.now() }; sg.tries++; sg.slot = slot;
  const p = new Peer(roomId + '-' + slot, { debug: 0, config: { iceServers: iceServers } });
  p.on('disconnected', () => { sg.err = 'disconnected@' + Math.round((Date.now() - sg.t0) / 1000) + 's'; if (me >= 0 && !p.destroyed) { status('Reconnecting...'); try { p.reconnect(); } catch (e) { /* next sweep retries */ } } });
  p.on('error', (e) => {
    if (e.type !== 'peer-unavailable') sg.err = e.type + '@' + Math.round((Date.now() - sg.t0) / 1000) + 's';
    if (e.type === 'unavailable-id' && me < 0) { p.destroy(); register(slot + 1); }
    else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') status('Network problem, retrying...');
    else if (e.type !== 'peer-unavailable') status('Connection problem: ' + e.type);
  });
  p.on('open', () => {
    peer = p; me = slot; window.__pr.peer = p;
    addVideo(slot, local, true);
    status('In the call');
    sweep();
  });
  p.on('connection', (c) => onConn(c, false));
  p.on('call', (call) => {
    const s = slotOf(call.peer);
    if (!call.peer.startsWith(roomId + '-') || !(s >= 0 && s < MAX)) { call.close(); return; }
    pending.set(s, call); tryAnswer(s);
    setTimeout(() => { if (pending.get(s) === call) { pending.delete(s); call.close(); } }, 40000);
  });
}
// Keep trying to reach empty slots so late joiners, dropped links and flaky networks heal themselves.
// Adaptive send quality: every peer gets its own copy of our video, so with more people we send each copy smaller.
let tuned = '';
function tuneSenders() {
  const n = Math.max(1, calls.size);
  const bps = n <= 1 ? 1200000 : n === 2 ? 700000 : n === 3 ? 450000 : n <= 5 ? 300000 : 180000;
  const scale = n <= 2 ? 1 : n === 3 ? 1.5 : n <= 5 ? 2 : 3;
  const rl = [...calls.values()].map((c) => (c.__relay ? 1 : 0)).join('');
  const key = n + ':' + bps + ':' + scale + ':' + rl; if (key === tuned) return; tuned = key;
  for (const call of calls.values()) {
    const pc = call.peerConnection; if (!pc) continue;
    // Calls that go through the free relay count against its small monthly data limit, so send those much smaller.
    const bps2 = call.__relay ? Math.min(bps, 120000) : bps, scale2 = call.__relay ? Math.max(scale, 3) : scale;
    for (const snd of pc.getSenders()) {
      if (!snd.track || snd.track.kind !== 'video' || !snd.getParameters) continue;
      try { const p = snd.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]; p.encodings[0].maxBitrate = bps2; p.encodings[0].scaleResolutionDownBy = scale2; snd.setParameters(p).catch(() => {}); } catch (e) { /* unsupported */ }
    }
  }
}
// Find out which calls are going through the relay (strict networks). Checked every few seconds; cheap.
async function probeRelay() {
  for (const call of calls.values()) {
    const pc = call.peerConnection; if (!pc || pc.connectionState !== 'connected') continue;
    try {
      const st = await pc.getStats(); let sel = null; const cands = new Map();
      st.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) sel = r; if (r.type === 'local-candidate') cands.set(r.id, r); });
      const lc = sel && cands.get(sel.localCandidateId); call.__relay = !!(lc && lc.candidateType === 'relay');
    } catch (e) { /* stats unavailable */ }
  }
  window.__pr.relayCalls = [...calls.values()].filter((c) => c.__relay).length;
}
function sweep() {
  if (!peer || peer.destroyed || me < 0) return;
  if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* retry */ } return; }
  broadcast(7, new Uint8Array(1), true);
  if (approvalMode && !selfOk) for (const c of conns.values()) if (c.__authed && !c.__host) send(c, 10, json({ name: myName }));
  let old = false; for (const c of conns.values()) if (c.__ok && !c.__peerOk && Date.now() - (c.__okAt || Date.now()) > 15000) old = true;
  if (old !== !!window.__pr.oldPeer) { window.__pr.oldPeer = old; updateMode(); }
  for (const c of conns.values()) if (Date.now() - (c.__last || 0) > 15000) c.close();
  for (let j = 0; j < MAX; j++) {
    if (j === me) continue;
    const c = conns.get(j);
    if (c && c.open) continue;
    const t = lastTry.get(j) || 0;
    if (Date.now() - t < 4000) continue;
    lastTry.set(j, Date.now());
    onConn(peer.connect(roomId + '-' + j, { reliable: true }), true);
  }
  probeRelay().then(tuneSenders);
  tuneSenders();
  if (window.__pr.relayBusy && !window.__pr.busyWarned) {
    for (const call of calls.values()) {
      const pc = call.peerConnection; if (!pc) continue;
      call.__seen = call.__seen || Date.now();
      if (pc.iceConnectionState === 'failed' || ((pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') && Date.now() - call.__seen > 20000)) { window.__pr.busyWarned = true; sysMsg('The free relay is busy this month, so some connections on strict networks cannot be made. Try Wi-Fi instead of cellular (or the other way around).'); break; }
    }
  }
  if ($('#status').textContent === 'Reconnecting...' || $('#status').textContent === 'Network problem, retrying...') status('In the call');
}

// ---- controls ----
function setTracks() {
  local.getAudioTracks().forEach((t) => { t.enabled = state.mic; }); if (voice.track) voice.track.enabled = state.mic;
  local.getVideoTracks().forEach((t) => { t.enabled = state.cam; }); if (face.track) face.track.enabled = state.cam;
  $('#mic').textContent = state.mic ? 'Mute' : 'Unmute'; $('#mic').classList.toggle('off', !state.mic);
  $('#camb').textContent = state.cam ? 'Camera off' : 'Camera on'; $('#camb').classList.toggle('off', !state.cam);
  paintTile(me); sendMeta();
}
function swapVideo(track) {
  for (const call of calls.values()) {
    const pc = call.peerConnection; if (!pc) continue;
    const snd = pc.getSenders().find((x) => x.track && x.track.kind === 'video') || pc.getSenders().find((x) => !x.track || x.track.kind === 'video');
    if (snd && track) snd.replaceTrack(track).catch(() => {});
  }
}
async function toggleShare() {
  if (screen) { stopShare(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { sysMsg('Screen share is not supported on this browser (phones usually cannot).'); return; }
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const t = screen.getVideoTracks()[0]; t.onended = stopShare;
    swapVideo(t); const box = tile(me).querySelector('video'); box.srcObject = screen;
    $('#share').textContent = 'Stop sharing'; paintTile(me); sendMeta();
  } catch (e) { screen = null; }
}
function stopShare() {
  if (!screen) return;
  screen.getTracks().forEach((t) => t.stop()); screen = null;
  const v = vidTracks()[0]; if (v) swapVideo(v);
  tile(me).querySelector('video').srcObject = face.on ? new MediaStream([face.track]) : local;
  $('#share').textContent = 'Share screen'; paintTile(me); sendMeta();
}
// ---- end room, verify code ----
function wipe(msg) {
  if (ended) return; ended = true;
  try { peer && peer.destroy(); } catch (e) { /* closing */ }
  for (const c of conns.values()) { try { c.close(); } catch (e) { /* closing */ } }
  conns.clear(); calls.clear(); incoming.clear(); info.clear();
  blobUrls.forEach((u) => URL.revokeObjectURL(u)); blobUrls.length = 0;
  if (local) local.getTracks().forEach((t) => t.stop());
  if (screen) screen.getTracks().forEach((t) => t.stop());
  $('#log').textContent = ''; $('#videos').textContent = ''; tiles.clear(); $('#knocks').textContent = '';
  key = null; aes = null; history.replaceState(null, '', location.pathname);
  $('#room').hidden = true; $('#gate').hidden = true; $('#ended').hidden = false; $('#endmsg').textContent = msg;
}
function burn() {
  if (!confirm('End the room for everyone and clear chat and files?')) return;
  broadcast(8, new Uint8Array(1), true);
  setTimeout(() => wipe('You ended the room. Chat and files were cleared from this tab.'), 300);
}
const EMOJI = ['🐶','🐱','🦊','🐻','🐼','🐨','🦁','🐯','🐸','🐵','🐔','🐧','🦉','🦋','🐢','🐙','🐳','🐬','🌵','🌲','🍀','🌻','🌙','⭐','🔥','🌈','❄️','🍎','🍋','🍇','🍉','🥑','🌽','🍕','🍩','🍪','⚽','🎲','🎸','🚀','🚲','⛵','🏠','🔑','🔔','💡','📌','🎈','🎁','🧲','🪁','🧩','🥁','🎯','🛶','⌚','☂️','👑','🧊','🪴','🍄','🦀','🐝','🐞'];
const fps = (pc) => { const t = [];
  for (const d of [pc.localDescription, pc.remoteDescription]) { const m = d && /a=fingerprint:(\S+) (\S+)/.exec(d.sdp); if (m) t.push(m[1] + ' ' + m[2]); }
  return t; };
async function codeFor(slot) {
  const c = conns.get(slot), call = calls.get(slot);
  if (!c || !call || !c.peerConnection || !call.peerConnection) return null;
  const all = [...fps(c.peerConnection), ...fps(call.peerConnection)];
  if (all.length < 4) return null;
  const h = await sha(all.sort().join('|'));
  return [0, 1, 2, 3, 4].map((i) => EMOJI[h[i] & 63]).join(' ');
}
async function showVerify() {
  const box = $('#verbox'); box.textContent = '';
  const slots = [...conns.entries()].filter(([, c]) => c.__started).map(([k]) => k);
  if (!slots.length) box.textContent = 'Nobody else is in the call yet.';
  for (const sl of slots) {
    const code = await codeFor(sl); const d = document.createElement('div'); d.className = 'ver';
    const n = document.createElement('b'); n.textContent = nameOf(sl); const cd = document.createElement('div'); cd.className = 'code'; cd.textContent = code || 'not ready yet, try again in a few seconds';
    d.append(n, cd); box.appendChild(d);
  }
  $('#verify').hidden = false; $('#sheet').hidden = true;
}
function leave() {
  try { peer && peer.destroy(); } catch (e) { /* closing */ }
  if (local) local.getTracks().forEach((t) => t.stop());
  if (screen) screen.getTracks().forEach((t) => t.stop());
  location.href = location.pathname; // key is dropped from the address; nothing was stored
}

function scan() {
  const a = window.__audit; let k = 0;
  for (const f of a.log) if (key && f.includes(key)) k++;
  return k;
}
function refresh() {
  const a = window.__audit;
  $('#audit').innerHTML = 'People connected directly: ' + conns.size + '<br>Encrypted messages sent / received: ' + stats.sent + ' / ' + stats.recv +
    '<br>Introduction server: ' + (a.hosts.join(', ') || 'none') + '<br>Messages sent to it: ' + a.frames + ' (' + a.bytes + ' bytes)' +
    '<br>Containing your room key: <b>' + scan() + '</b>';
}

async function start(useCam) {
  parseHash();
  if (expiryMin && Date.now() / 60000 > expiryMin) { wipe('This room has expired.'); return; }
  myName = ($('#name').value || '').trim().slice(0, 24);
  roomId = hex(await sha('room:' + key)).slice(0, 24);
  aes = await crypto.subtle.importKey('raw', await sha('enc:' + key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  window.__pr.roomId = roomId;
  $('#gate').hidden = true; $('#room').hidden = false;
  local = await getStream(useCam);
  if (useCam && !local.getAudioTracks().length) showMicHelp();
  state.mic = local.getAudioTracks().length > 0; state.cam = local.getVideoTracks().length > 0 && useCam;
  $('#mic').onclick = () => { state.mic = !state.mic; setTracks(); };
  $('#camb').onclick = () => { state.cam = !state.cam; setTracks(); };
  $('#share').onclick = () => { $('#sheet').hidden = true; toggleShare(); };
  $('#more').onclick = () => { $('#sheet').hidden = !$('#sheet').hidden; };
  $('#sheetx').onclick = () => { $('#sheet').hidden = true; };
  $('#face').onchange = (e) => setFace(e.target.value); $('#voice').onchange = (e) => setVoice(e.target.value); $('#hear').onchange = (e) => { voice.hear = e.target.checked; if (voice.ctx) voiceApply(); };
  $('#verbtn').onclick = showVerify; $('#verclose').onclick = () => { $('#verify').hidden = true; };
  $('#burn').onclick = () => { $('#sheet').hidden = true; if (!approvalMode || isHost) burn(); };
  $('#burn').hidden = approvalMode && !isHost;
  $('#waitleave').onclick = leave; $('#again').onclick = () => { location.href = location.pathname; };
  $('#leave').onclick = leave;
  $('#chatbtn').onclick = () => { const p = $('#chatpanel'); p.hidden = !p.hidden; $('#main').classList.toggle('chat', !p.hidden); $('#chatbtn').classList.remove('ping'); if (!p.hidden) { $('#log').scrollTop = 1e9; } };
  // Keep the whole call screen inside the visible area when the phone keyboard opens, so the message box and buttons stay reachable.
  if (window.visualViewport) { const vv = window.visualViewport; const fit = () => { const r = $('#room'); r.style.height = vv.height + 'px'; r.style.top = vv.offsetTop + 'px'; }; vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
  $('#sendf').onsubmit = (e) => { e.preventDefault(); const t = $('#msg').value.trim(); if (!t) return; addMsg('You', t, true, me); broadcast(0, json({ t })); $('#msg').value = ''; };
  $('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f); };
  $('#attach').onclick = () => $('#file').click();
  $('#copy').onclick = openInvite;
  $('#lock').hidden = !isHost; $('#lock').onclick = () => setLock(!locked);
  updateMode();
  $('#mode').className = approvalMode ? 'on' : 'open';
  setTracks();
  if (!selfOk) { $('#wait').hidden = false; status('Waiting for the host'); }
  if (expiryMin) setInterval(() => { if (Date.now() / 60000 > expiryMin) wipe('This room expired. Chat and files were cleared.'); }, 10000);
  loadIce().then(() => register(0));
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  setInterval(sweep, 4000); setInterval(health, 1000);
  document.addEventListener('click', () => { for (const b of tiles.values()) { const v = b.querySelector('video'); if (v.paused) tryPlay(v, b); } }, true);
  setInterval(refresh, 1000);
  window.addEventListener('online', sweep);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sweep(); });
}

// ---- scheduled calls: the start time lives in the link after the #, so no server ever sees it ----
function whenText() {
  if (!startMin) return '';
  const d = new Date(startMin * 60000), left = startMin - Math.floor(Date.now() / 60000);
  const t = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (left > 1440) return 'Scheduled for ' + t + ' (in ' + Math.round(left / 1440) + ' days).';
  if (left > 90) return 'Scheduled for ' + t + ' (in ' + Math.round(left / 60) + ' hours).';
  if (left > 1) return 'Scheduled for ' + t + ' (in ' + left + ' min). You can join early and wait.';
  if (left > -180) return 'Scheduled for ' + t + '. It is time.';
  return 'This call was scheduled for ' + t + '.';
}
const BRAND_COLORS = ['#B9F27C', '#7CC4F2', '#F2B97C', '#F27CA8', '#C49CF2', '#F2E27C'];
function paintBrand() {
  const hs = location.hash.slice(1).split('.').slice(1);
  if (!hs.some((t) => 'ncl'.includes(t[0]))) return;
  brand = { n: '', c: -1, l: '' };
  for (const t of hs) { if (t[0] === 'n') { try { brand.n = dec.decode(unb64(t.slice(1))).slice(0, 24); } catch (e) { /* ignore */ } } else if (t[0] === 'c') brand.c = parseInt(t.slice(1), 10); else if (t[0] === 'l' && /^[A-Za-z0-9_-]{20,3200}$/.test(t.slice(1))) brand.l = t.slice(1); }
  if (brand.c >= 0 && BRAND_COLORS[brand.c]) { document.documentElement.style.setProperty('--signal', BRAND_COLORS[brand.c]); document.documentElement.style.setProperty('--good', BRAND_COLORS[brand.c]); }
  const mk = (box) => { if (!box) return; box.textContent = ''; if (brand.l) { const im = document.createElement('img'); im.src = 'data:image/webp;base64,' + brand.l.replace(/-/g, '+').replace(/_/g, '/'); im.alt = ''; im.width = im.height = 28; im.style.cssText = 'border-radius:7px;vertical-align:middle;margin-right:8px'; box.appendChild(im); } box.appendChild(document.createTextNode(brand.n || 'mut3d')); };
  mk(document.querySelector('.top h1')); mk(document.querySelector('#join-brand'));
  if (brand.n) document.title = brand.n;
  const jb = document.querySelector('#join-brand'); if (jb) jb.hidden = !brand.n && !brand.l;
}
async function makeLogo(file) {
  const bm = await createImageBitmap(file); const cv = document.createElement('canvas'); cv.width = cv.height = 48; const x = cv.getContext('2d');
  const m = Math.min(bm.width, bm.height); x.drawImage(bm, (bm.width - m) / 2, (bm.height - m) / 2, m, m, 0, 0, 48, 48);
  for (const q of [0.7, 0.5, 0.35, 0.2]) { const u = cv.toDataURL('image/webp', q); if (u.startsWith('data:image/webp;base64,')) { const b = u.slice(23).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); if (b.length <= 1600) return b; } }
  return '';
}
function readStart() { startMin = 0; for (const t of location.hash.slice(1).split('.').slice(1)) if (t[0] === 't') startMin = parseInt(t.slice(1), 36) || 0; if (!key) key = location.hash.slice(1).split('.')[0]; }
function paintWhen() { readStart(); paintBrand(); const w = $('#when-note'); if (!w) return; const t = whenText(); w.textContent = t; w.hidden = !t || location.hash.length <= 10; $('#ics').hidden = w.hidden; $('#joininvite').hidden = w.hidden; }
function downloadIcs() {
  if (me < 0) parseHash();
  if (!startMin) return;
  const f = (m) => new Date(m * 60000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = inviteLink();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mut3d//EN', 'BEGIN:VEVENT', 'UID:' + f(startMin) + '-' + key.slice(0, 8) + '@mut3d', 'DTSTAMP:' + f(Math.floor(Date.now() / 60000)), 'DTSTART:' + f(startMin), 'DTEND:' + f(startMin + 60), 'SUMMARY:mut3d call', 'DESCRIPTION:Join here: ' + url, 'URL:' + url, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = 'mut3d-call.ics'; document.body.appendChild(a); a.click(); a.remove();
  window.__pr.icsMade = ics;
}
function bindInvite() {
  $('#invclose').onclick = () => { $('#invite').hidden = true; };
  $('#invcopy').onclick = () => copyText(inviteUrl, $('#invcopy'), 'Copied');
  $('#invshare').onclick = () => { navigator.share({ title: 'Join my mut3d call', text: 'Join my call on mut3d', url: inviteUrl }).catch(() => {}); };
  $('#invshort').onclick = async () => {
    const b = $('#invshort'); b.disabled = true; b.textContent = 'Making it...';
    try { inviteUrl = await makeShort(); $('#invurl').textContent = inviteUrl; drawQr(inviteUrl); $('#invshortnote').hidden = false; b.textContent = 'Short link ready'; window.__pr.shortUrl = inviteUrl; }
    catch (e) { b.textContent = 'Short link unavailable'; window.__pr.shortErr = String(e && e.message); } finally { setTimeout(() => { b.disabled = false; b.textContent = 'Make a short link'; }, 3000); }
  };
}
async function boot() {
  bindInvite();
  await resolveShort();
  const hasKey = () => location.hash.length > 10;
  $('#create').onclick = async () => {
    const parts = [b64u(crypto.getRandomValues(new Uint8Array(16)))];
    const wv = $('#when').value, wt = wv ? new Date(wv).getTime() : 0, st = wt > Date.now() ? Math.floor(wt / 60000) : 0;
    const base = st || Math.floor(Date.now() / 60000);
    const bn = $('#brandname').value.trim().slice(0, 24), bc = +$('#brandcolor').value, bl = window.__pr.brandLogo || '';
    const bt = []; if (bn) bt.push('n' + b64u(enc.encode(bn))); if (bn && bc >= 0) bt.push('c' + bc); if (bl) bt.push('l' + bl); parts.push(...bt);
    if ($('#approve').checked) { const k = await hostKeys(); parts.push('p' + k.pub); const ex = +$('#expire').value; if (ex) parts.push('e' + (base + ex).toString(36)); if (st) parts.push('t' + st.toString(36)); parts.push('s' + k.priv); }
    else { const ex = +$('#expire').value; if (ex) parts.push('e' + (base + ex).toString(36)); if (st) parts.push('t' + st.toString(36)); }
    location.hash = parts.join('.'); show();
  };
  $('#cam').onclick = () => start(true);
  $('#nocam').onclick = () => start(false);
  function show() { $('#create').hidden = hasKey(); $('#join').hidden = !hasKey(); $('#opts').hidden = hasKey(); $('#apr').hidden = hasKey(); paintWhen(); }
  show();
  setInterval(paintWhen, 20000);
  $('#brandlogo').onchange = async (e) => { const f = e.target.files[0]; window.__pr.brandLogo = ''; $('#brandlogonote').textContent = ''; if (!f) return; try { window.__pr.brandLogo = await makeLogo(f); $('#brandlogonote').textContent = window.__pr.brandLogo ? 'Logo ready' : 'That image would not shrink enough'; } catch (err) { $('#brandlogonote').textContent = 'Could not read that image'; } };
  $('#ics').onclick = downloadIcs; $('#joininvite').onclick = openInvite; $('#invics').onclick = downloadIcs;
  window.addEventListener('hashchange', show);
}
boot();

// ---- feedback: sends only what the sheet previews, nothing about rooms, keys, names or chat ----
(function () {
  const q = (s) => document.querySelector(s); if (!q('#fb')) return;
  const build = () => {
    const w = (document.querySelector('input[name=fbw]:checked') || {}).value || '';
    const o = { worked: w, text: q('#fbtext').value.trim().slice(0, 1500) };
    if (q('#fbdev').checked) { o.diag = diagText().slice(0, 600); o.app = APP_NAME + ' ' + VERSION; o.device = (navigator.userAgent || '').slice(0, 160); o.screen = window.screen.width + 'x' + window.screen.height; }
    return o;
  };
  const prev = () => { q('#fbprev').textContent = JSON.stringify(build(), null, 1); };
  const open = (e) => { if (e) e.preventDefault(); q('#sheet').hidden = true; q('#fbmsg').textContent = ''; q('#fbsend').disabled = false; prev(); q('#fb').hidden = false; };
  q('#fbhome').onclick = open; q('#fbmore').onclick = open;
  q('#fbclose').onclick = () => { q('#fb').hidden = true; };
  for (const s of ['#fbtext', '#fbdev', 'input[name=fbw]']) document.querySelectorAll(s).forEach((n) => { n.oninput = prev; n.onchange = prev; });
  q('#fbsend').onclick = async () => {
    const o = build(); if (!o.text && !o.worked) { q('#fbmsg').textContent = 'Write something or pick one first.'; return; }
    q('#fbsend').disabled = true; q('#fbmsg').textContent = 'Sending...';
    try {
      const r = await fetch('/fb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o), referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (r.ok) { q('#fbmsg').textContent = 'Sent. Thank you.'; q('#fbtext').value = ''; setTimeout(() => { q('#fb').hidden = true; }, 1200); }
      else { q('#fbmsg').textContent = r.status === 429 ? 'Too many sends, try again later.' : 'Could not send (' + r.status + ').'; q('#fbsend').disabled = false; }
    } catch (e) { q('#fbmsg').textContent = 'Could not send. Check your connection.'; q('#fbsend').disabled = false; }
  };
})();

// ---- connection diagnostics: one screenshot shows where a link stalls. No room id, key or names. ----
function candOf(pc, holder) {
  if (!pc || !pc.getStats) return;
  pc.getStats().then((rep) => {
    let sel = null; const cands = {};
    rep.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
    rep.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) sel = rep.get(r.selectedCandidatePairId); });
    if (!sel) rep.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) sel = r; });
    const l = sel && cands[sel.localCandidateId], m = sel && cands[sel.remoteCandidateId];
    holder.__cand = sel ? (l ? l.candidateType : '?') + '>' + (m ? m.candidateType : '?') : 'none';
  }).catch(() => {});
}
function diagText() {
  const L = [APP_NAME + ' ' + VERSION + ' sig:' + (peer ? (peer.open ? 'ok' : peer.disconnected ? 'down' : 'wait') : 'none') + ' slot:' + me + (window.__pr.sig ? ' tries:' + window.__pr.sig.tries + (window.__pr.sig.err ? ' err:' + window.__pr.sig.err : '') : '') + (window.__pr.relay ? ' relay:on' : ' relay:off') + (isHost ? ' host' : '') + (approvalMode ? ' approval' : ' open') + (approvalMode && !isHost ? (selfOk ? ' admitted' : ' not-admitted') : '')];
  for (const [s, c] of conns) { const pc = c.peerConnection; L.push('data' + s + ': ' + (c.open ? 'open' : 'closed') + ' ice=' + (pc ? pc.iceConnectionState : '-') + ' auth=' + (c.__authed ? 1 : 0) + ' ok=' + (c.__ok ? 1 : 0) + ' via=' + (c.__cand || '?')); }
  for (const [s, c] of calls) { const pc = c.peerConnection; L.push('media' + s + ': ice=' + (pc ? pc.iceConnectionState : '-') + ' via=' + (c.__cand || '?')); }
  if (!conns.size) L.push('no peers connected yet');
  return L.join('\n');
}
setInterval(() => { for (const c of conns.values()) candOf(c.peerConnection, c); for (const c of calls.values()) candOf(c.peerConnection, c); const t = diagText(); const a = document.querySelector('#diag'), w = document.querySelector('#diagw'); if (a) a.textContent = t; if (w) w.textContent = t; }, 2000);
