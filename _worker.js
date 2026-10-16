// Feedback endpoint for mut3d (Cloudflare D1). Stores only {worked, text, optional app/device/screen} and a timestamp.
// No room id, key, name, chat or IP is stored. A salted hash of the IP is kept for at most one hour, for rate limiting only.
const MAX = 3000;
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS fb (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, worked TEXT, text TEXT, app TEXT, device TEXT, screen TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, exp INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sl (id TEXT PRIMARY KEY, c TEXT, exp INTEGER)'),
  ]);
  try { await db.prepare('ALTER TABLE fb ADD COLUMN diag TEXT').run(); } catch (e) { /* exists */ }
  ready = true;
}
// Deletes expired rate-limit rows (scrambled address + hour) and expired short links. Runs on any request, at most once a minute per instance.
async function purge(db, now) {
  if (globalThis.__pg && now - globalThis.__pg < 60000) return;
  globalThis.__pg = now;
  try { await db.batch([db.prepare('DELETE FROM rl WHERE exp < ?').bind(now), db.prepare('DELETE FROM sl WHERE exp < ?').bind(now)]); } catch (e) { /* retry next minute */ }
}
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/turn' && req.method === 'GET') {
      // Relay fallback credentials: short-lived, same-origin only, rate limited. Nothing about rooms or people is logged.
      const off = () => new Response('{}', { status: 503, headers: { 'cache-control': 'no-store' } });
      try {
        if (!env.TURN_SECRET || !env.DB) return off();
        const sf = req.headers.get('sec-fetch-site'); if (sf && sf !== 'same-origin') return new Response('no', { status: 403 });
        await init(env.DB);
        const now = Date.now();
        await purge(env.DB, now);
        const ip = req.headers.get('cf-connecting-ip') || 'x';
        const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.SALT || 's') + ip)))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
        const hk = 't:' + h + ':' + Math.floor(now / 3600000), dk = 'td:' + Math.floor(now / 86400000);
        const get = async (k) => ((await env.DB.prepare('SELECT n FROM rl WHERE k=?').bind(k).first()) || { n: 0 }).n;
        if ((await get(hk)) >= 20 || (await get(dk)) >= 600) return new Response('slow down', { status: 429 });
        const up = (k, ttl) => env.DB.prepare('INSERT INTO rl (k,n,exp) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k, now + ttl).run();
        await up(hk, 3700000); await up(dk, 90000000);
        // Free metered trial has a monthly quota. When it is nearly used up, say so instead of handing out credentials that will not work.
        if (!globalThis.__tu || globalThis.__tu.exp < now) {
          let busy = false;
          try { const u2 = await fetch('https://arbonomous-mut3d.metered.live/api/v1/turn/current_usage?secretKey=' + encodeURIComponent(env.TURN_SECRET)); if (u2.ok) { const j2 = await u2.json(); busy = j2.quotaInGB > 0 && j2.usageInGB >= j2.quotaInGB * 0.95; } } catch (e) { /* fail open */ }
          globalThis.__tu = { exp: now + 300000, busy };
        }
        if (globalThis.__tu.busy) return new Response('{"busy":true,"iceServers":[]}', { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        if (!globalThis.__turn || globalThis.__turn.exp < now) {
          const r = await fetch('https://arbonomous-mut3d.metered.live/api/v1/turn/credential?secretKey=' + encodeURIComponent(env.TURN_SECRET), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expiryInSeconds: 1800, label: 'mut3d' }) });
          if (!r.ok) return off();
          const c = await r.json(); if (!c.username || !c.password) return off();
          globalThis.__turn = { exp: now + 600000, c };
        }
        const c = globalThis.__turn.c;
        const iceServers = [
          { urls: 'turn:global.relay.metered.ca:80', username: c.username, credential: c.password },
          { urls: 'turn:global.relay.metered.ca:443', username: c.username, credential: c.password },
          { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: c.username, credential: c.password },
        ];
        return new Response(JSON.stringify({ iceServers }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch (e) { return off(); }
    }
    if (u.pathname === '/s' && req.method === 'POST') {
      // Short invite links: stores only an AES-GCM ciphertext made in the browser. The unlock code stays in the link after the #. Kept 24 hours.
      try {
        if (!env.DB) return new Response('off', { status: 503 });
        const sf = req.headers.get('sec-fetch-site'); if (sf && sf !== 'same-origin') return new Response('no', { status: 403 });
        const raw = await req.text(); if (raw.length > 6000) return new Response('too big', { status: 413 });
        let o; try { o = JSON.parse(raw); } catch { return new Response('bad', { status: 400 }); }
        if (typeof o.c !== 'string' || !/^[A-Za-z0-9_-]{40,5000}$/.test(o.c)) return new Response('bad', { status: 400 });
        await init(env.DB);
        const now = Date.now();
        await purge(env.DB, now);
        const ip = req.headers.get('cf-connecting-ip') || 'x';
        const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.SALT || 's') + ip)))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
        const hk = 's:' + h + ':' + Math.floor(now / 3600000), dk = 'sd:' + Math.floor(now / 86400000);
        const get = async (k) => ((await env.DB.prepare('SELECT n FROM rl WHERE k=?').bind(k).first()) || { n: 0 }).n;
        if ((await get(hk)) >= 20 || (await get(dk)) >= 2000) return new Response('slow down', { status: 429 });
        const up = (k, ttl) => env.DB.prepare('INSERT INTO rl (k,n,exp) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k, now + ttl).run();
        await up(hk, 3700000); await up(dk, 90000000);
        await env.DB.prepare('DELETE FROM sl WHERE exp < ?').bind(now).run();
        const A = 'abcdefghijklmnopqrstuvwxyz234567'; const id = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => A[x % 32]).join('');
        await env.DB.prepare('INSERT INTO sl (id,c,exp) VALUES (?,?,?)').bind(id, o.c, now + 86400000).run();
        return new Response(JSON.stringify({ id }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch (e) { return new Response('err', { status: 500 }); }
    }
    if (u.pathname.startsWith('/s/') && req.method === 'GET') {
      const id = u.pathname.slice(3);
      if (u.searchParams.get('j') === '1') {
        try {
          if (!/^[a-z2-7]{6,16}$/.test(id) || !env.DB) return new Response('no', { status: 404 });
          const r = await env.DB.prepare('SELECT c FROM sl WHERE id=? AND exp>?').bind(id, Date.now()).first();
          if (!r) return new Response('gone', { status: 404, headers: { 'cache-control': 'no-store' } });
          return new Response(JSON.stringify({ c: r.c }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        } catch (e) { return new Response('err', { status: 500 }); }
      }
      return env.ASSETS.fetch(new Request(new URL('/', req.url), req));
    }
    if (u.pathname === '/fb' && req.method === 'POST') {
      try {
        if (!env.DB) return new Response('off', { status: 503 });
        if (+(req.headers.get('content-length') || 0) > MAX) return new Response('too big', { status: 413 });
        const raw = await req.text(); if (raw.length > MAX) return new Response('too big', { status: 413 });
        let o; try { o = JSON.parse(raw); } catch { return new Response('bad', { status: 400 }); }
        const text = typeof o.text === 'string' ? o.text.slice(0, 1500) : '';
        const worked = o.worked === 'yes' || o.worked === 'no' ? o.worked : '';
        if (!text && !worked) return new Response('empty', { status: 400 });
        const c = (k) => (typeof o[k] === 'string' ? o[k].slice(0, 160) : null);
        await init(env.DB);
        const now = Date.now();
        await env.DB.prepare('DELETE FROM rl WHERE exp < ?').bind(now).run();
        await env.DB.prepare('DELETE FROM fb WHERE at < ?').bind(new Date(now - 60 * 86400000).toISOString()).run();
        const ip = req.headers.get('cf-connecting-ip') || 'x';
        const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.SALT || 's') + ip)))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
        const hk = 'h:' + h + ':' + Math.floor(now / 3600000), dk = 'd:' + Math.floor(now / 86400000);
        const get = async (k) => ((await env.DB.prepare('SELECT n FROM rl WHERE k=?').bind(k).first()) || { n: 0 }).n;
        if ((await get(hk)) >= 5) return new Response('slow down', { status: 429 });
        if ((await get(dk)) >= 300) return new Response('full', { status: 429 });
        const up = (k, ttl) => env.DB.prepare('INSERT INTO rl (k,n,exp) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k, now + ttl).run();
        await up(hk, 3700000); await up(dk, 90000000);
        await env.DB.prepare('INSERT INTO fb (at,worked,text,app,device,screen,diag) VALUES (?,?,?,?,?,?,?)').bind(new Date(now).toISOString(), worked, text, c('app'), c('device'), c('screen'), typeof o.diag === 'string' ? o.diag.slice(0, 600) : null).run();
        return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } });
      } catch (e) { return new Response('err', { status: 500 }); }
    }
    if (u.pathname === '/fb/list') {
      if (!env.DB || !env.ADMIN || req.headers.get('authorization') !== 'Bearer ' + env.ADMIN) return new Response('no', { status: 401 });
      await init(env.DB);
      const since = +(u.searchParams.get('since') || 0);
      const r = await env.DB.prepare('SELECT id,at,worked,text,app,device,screen,diag FROM fb WHERE id > ? ORDER BY id LIMIT 100').bind(since).all();
      return new Response(JSON.stringify(r.results), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
};
