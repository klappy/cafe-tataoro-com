// cafe.tataoro.com — Workers app: static assets + shared bakeoff vote tally + admin dashboard.
// Static assets are served by the [assets] binding. This Worker handles /api/votes, /api/notify,
// lightweight KV-counter instrumentation on public HTML pages, and the /admin dashboard (worker-
// native auth, no external deps). Everything else falls through to the static site.
const KEY = 'tally';
const CONCEPTS = ['A', 'B', 'C'];
const EMPTY = { A: 0, B: 0, C: 0 };
const PAGES = ['index', 'concept-a', 'concept-b', 'concept-c', 'bakeoff'];
const PAGE_MAP = {
  '/': 'index',
  '/index.html': 'index',
  '/concept-a': 'concept-a',
  '/concept-a.html': 'concept-a',
  '/concept-b': 'concept-b',
  '/concept-b.html': 'concept-b',
  '/concept-c': 'concept-c',
  '/concept-c.html': 'concept-c',
  '/bakeoff': 'bakeoff',
  '/bakeoff.html': 'bakeoff',
};
const STATS_TTL_SECONDS = 400 * 24 * 60 * 60; // 400-day retention (PRD instrumentation section)
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_SECONDS = 60 * 60;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// ---- pure helpers (exported for test/smoke.mjs) --------------------------------------------

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufToHex(digest);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bufToHex(sig);
}

// Constant-time-ish string compare (fixed-cost XOR over the full length; no early return on match).
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  return diff === 0;
}

async function hashPassword(password, salt) {
  return sha256Hex(salt + password);
}

async function verifyPassword(password, salt, expectedHex) {
  const computed = await hashPassword(password, salt);
  return timingSafeEqual(computed, expectedHex);
}

async function signSession(exp, secret) {
  const sig = await hmacSha256Hex(secret, String(exp));
  return `${exp}.${sig}`;
}

async function verifySession(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  const idx = cookieValue.indexOf('.');
  if (idx < 0) return false;
  const exp = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacSha256Hex(secret, exp);
  return timingSafeEqual(sig, expected);
}

function dateUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function counterKey(date, kind, value) {
  return value === undefined ? `d:${date}:${kind}` : `d:${date}:${kind}:${value}`;
}

function pageForPath(pathname) {
  return PAGE_MAP[pathname] || null;
}

function detectLang(url, request) {
  const q = url.searchParams.get('lang');
  if (q === 'en' || q === 'es') return q;
  const al = request.headers.get('accept-language') || '';
  const first = al.split(',')[0].trim().slice(0, 2).toLowerCase();
  if (first === 'en' || first === 'es') return first;
  return null;
}

function externalRefHost(request, url) {
  const ref = request.headers.get('referer');
  if (!ref) return null;
  try {
    const refUrl = new URL(ref);
    if (refUrl.host === url.host) return null;
    return refUrl.host;
  } catch {
    return null;
  }
}

function lastNDates(n, from = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(dateUTC(new Date(from.getTime() - i * 86400000)));
  }
  return out;
}

function toCsv(waitlist) {
  const header = ['email', 'intent', 'lang', 'utm', 'date', 'synced_to_shopify'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = waitlist.map((r) => [r.email, r.intent, r.lang, r.utm, r.ts, r.synced_to_shopify ? 'yes' : 'no']);
  return [header, ...rows].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n';
}

// ---- KV plumbing ----------------------------------------------------------------------------

async function readTally(env) {
  if (!env.VOTES) return { ...EMPTY };
  const raw = await env.VOTES.get(KEY);
  if (!raw) return { ...EMPTY };
  try { const v = JSON.parse(raw); return { A: v.A | 0, B: v.B | 0, C: v.C | 0 }; } catch { return { ...EMPTY }; }
}

async function incrKV(env, key) {
  if (!env.STATS) return;
  try {
    const cur = await env.STATS.get(key);
    const next = (parseInt(cur, 10) || 0) + 1;
    await env.STATS.put(key, String(next), { expirationTtl: STATS_TTL_SECONDS });
  } catch {
    // stat writes must never break the public response
  }
}

async function recordPageView(env, request, url, page) {
  try {
    const date = dateUTC();
    const tasks = [incrKV(env, counterKey(date, 'views', page))];
    const lang = detectLang(url, request);
    if (lang) tasks.push(incrKV(env, counterKey(date, 'lang', lang)));
    const utm = url.searchParams.get('utm_source');
    if (utm) tasks.push(incrKV(env, counterKey(date, 'utm', utm.slice(0, 40))));
    const refHost = externalRefHost(request, url);
    if (refHost) tasks.push(incrKV(env, counterKey(date, 'ref', refHost.slice(0, 60))));
    const country = request.cf && request.cf.country;
    if (country) tasks.push(incrKV(env, counterKey(date, 'country', country)));
    await Promise.all(tasks);
  } catch {
    // stat writes must never break the public response
  }
}

// Lists every `d:*` key in STATS and folds it into { date: { kind: { value: count } } }.
// `votes`/`signups` counters (no value segment) are stored under the '' value key.
async function loadAllStats(env) {
  const stats = {};
  if (!env.STATS) return stats;
  const keys = [];
  let cursor;
  do {
    const res = await env.STATS.list({ prefix: 'd:', cursor });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  const entries = await Promise.all(keys.map(async (name) => {
    const raw = await env.STATS.get(name);
    return [name, parseInt(raw, 10) || 0];
  }));
  for (const [name, count] of entries) {
    const parts = name.split(':');
    const date = parts[1];
    const kind = parts[2];
    const value = parts.length > 3 ? parts.slice(3).join(':') : '';
    stats[date] ??= {};
    stats[date][kind] ??= {};
    stats[date][kind][value] = (stats[date][kind][value] || 0) + count;
  }
  return stats;
}

function sumKind(stats, dates, kind, value) {
  let total = 0;
  for (const date of dates) {
    const byKind = stats[date] && stats[date][kind];
    if (!byKind) continue;
    if (value !== undefined) total += byKind[value] || 0;
    else for (const v in byKind) total += byKind[v];
  }
  return total;
}

function sumAllValues(stats, dates, kind) {
  const out = {};
  for (const date of dates) {
    const byKind = stats[date] && stats[date][kind];
    if (!byKind) continue;
    for (const v in byKind) {
      if (v === '') continue;
      out[v] = (out[v] || 0) + byKind[v];
    }
  }
  return out;
}

function topN(obj, n = 5) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

async function loadWaitlist(env) {
  if (!env.WAITLIST) return [];
  const records = [];
  let cursor;
  do {
    const res = await env.WAITLIST.list({ prefix: 'waitlist:', cursor });
    for (const k of res.keys) {
      const raw = await env.WAITLIST.get(k.name);
      if (!raw) continue;
      try { records.push(JSON.parse(raw)); } catch { /* skip malformed record */ }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  records.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return records;
}

async function buildSummary(env) {
  const [stats, waitlist] = await Promise.all([loadAllStats(env), loadWaitlist(env)]);
  const dates7 = lastNDates(7);
  const dates14 = lastNDates(14);

  const viewsByPage7 = {};
  for (const p of PAGES) {
    viewsByPage7[p] = sumKind(stats, dates7, 'views', p);
  }
  const totalViews7 = PAGES.reduce((s, p) => s + viewsByPage7[p], 0);
  const signups7 = sumKind(stats, dates7, 'signups');
  const buys7 = sumKind(stats, dates7, 'buy');
  const conversion7 = totalViews7 > 0 ? (signups7 / totalViews7) * 100 : 0;
  const buyRate7 = totalViews7 > 0 ? (buys7 / totalViews7) * 100 : 0;

  const viewsPerDay14 = dates14.slice().reverse().map((date) => ({
    date,
    views: PAGES.reduce((s, p) => s + sumKind(stats, [date], 'views', p), 0),
  }));

  const dropoffViewsToSignups = totalViews7 > 0 ? Number((100 - (signups7 / totalViews7) * 100).toFixed(2)) : 0;
  const dropoffViewsToBuys = totalViews7 > 0 ? Number((100 - (buys7 / totalViews7) * 100).toFixed(2)) : 0;

  return {
    topline: {
      waitlistTotal: waitlist.length,
      signups7d: signups7,
      buys7d: buys7,
      views7d: totalViews7,
      conversion7d: Number(conversion7.toFixed(2)),
      buyRate7d: Number(buyRate7.toFixed(2)),
    },
    waitlist: waitlist.map((r) => ({
      email: r.email, intent: r.intent, lang: r.lang, utm: r.utm, ts: r.ts, synced: !!r.synced_to_shopify,
    })),
    traffic: {
      viewsPerDay14,
      langSplit: sumAllValues(stats, dates14, 'lang'),
      topUtm: topN(sumAllValues(stats, dates14, 'utm')),
      topReferrers: topN(sumAllValues(stats, dates14, 'ref')),
      topCountries: topN(sumAllValues(stats, dates14, 'country')),
      buyBySrc: sumAllValues(stats, dates14, 'buysrc'),
      barriers: sumAllValues(stats, dates14, 'barrier'),
    },
    funnel7d: {
      views: totalViews7, buys: buys7, signups: signups7, dropoffViewsToBuys, dropoffViewsToSignups,
    },
  };
}

// ---- admin: cookies + rendering -------------------------------------------------------------

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLogin(status = 200) {
  const message = status === 429
    ? 'Too many attempts. Try again later.'
    : (status === 401 ? 'Invalid username or password.' : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Café Tata Oro</title>
<style>
body{font-family:system-ui,sans-serif;background:#faf6f1;color:#2b2118;display:flex;min-height:100vh;
  align-items:center;justify-content:center;margin:0;padding:16px}
form{background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:320px}
h1{font-size:1.1rem;margin:0 0 16px}
label{display:block;margin:12px 0 4px;font-size:.85rem}
input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:1rem;box-sizing:border-box}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:#6b4226;color:#fff;font-size:1rem}
.err{color:#b3261e;font-size:.85rem;margin-top:8px}
</style></head><body>
<form method="post" action="/admin/login">
<h1>Café Tata Oro — Admin</h1>
<label for="u">User</label>
<input id="u" name="u" autocomplete="username" required>
<label for="p">Password</label>
<input id="p" name="p" type="password" autocomplete="current-password" required>
<button type="submit">Log in</button>
${message ? `<div class="err">${esc(message)}</div>` : ''}
</form>
</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function renderDashboard() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin dashboard — Café Tata Oro</title>
<style>
:root{color-scheme:light}
body{font-family:system-ui,sans-serif;background:#faf6f1;color:#2b2118;margin:0;padding:12px}
h1{font-size:1.2rem} h2{font-size:1rem;margin-top:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.card{background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 6px rgba(0,0,0,.06)}
.card .n{font-size:1.4rem;font-weight:700} .card .l{font-size:.75rem;color:#6b5d4f}
table{width:100%;border-collapse:collapse;font-size:.8rem;background:#fff;border-radius:8px;overflow:hidden;
  display:block;overflow-x:auto;white-space:nowrap}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #eee}
.bars{display:flex;align-items:flex-end;gap:2px;height:80px;background:#fff;border-radius:8px;padding:8px;box-sizing:border-box}
.bar{background:#6b4226;flex:1;min-width:4px}
.row{display:flex;justify-content:space-between;font-size:.8rem;padding:4px 8px;background:#fff;border-bottom:1px solid #eee}
.top-actions{display:flex;gap:8px;margin-bottom:8px}
.btn{display:inline-block;background:#6b4226;color:#fff;text-decoration:none;padding:6px 10px;border-radius:6px;font-size:.8rem;border:0}
#err{color:#b3261e}
</style></head><body>
<div class="top-actions">
<a class="btn" href="/admin/waitlist.csv">Export waitlist CSV</a>
<form method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>
</div>
<h1>Dashboard</h1>
<div id="err"></div>
<div id="app">Loading…</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function card(n,l){return '<div class="card"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>';}
function rows(obj){
  var entries=Object.entries(obj).sort(function(a,b){return b[1]-a[1];});
  if(!entries.length) return '<div class="row"><span>No data</span><span></span></div>';
  return entries.map(function(e){return '<div class="row"><span>'+esc(e[0]||'(none)')+'</span><span>'+esc(e[1])+'</span></div>';}).join('');
}
fetch('/admin/api/summary').then(function(r){
  if(!r.ok) throw new Error('failed to load');
  return r.json();
}).then(render).catch(function(){
  document.getElementById('err').textContent='Failed to load summary.';
});
function render(d){
  var app=document.getElementById('app');
  var t=d.topline;
  var h='';
  h+='<div class="cards">'+card(t.views7d,'Views (7d)')+card(t.buys7d,'Buy clicks (7d)')+
    card(t.buyRate7d+'%','View\\u2192buy (7d)')+card(t.waitlistTotal,'Waitlist total')+
    card(t.signups7d,'Signups (7d)')+card(t.conversion7d+'%','View\\u2192signup (7d)')+'</div>';

  h+='<h2>Traffic (14d)</h2>';
  var max=Math.max.apply(null,[1].concat(d.traffic.viewsPerDay14.map(function(x){return x.views;})));
  h+='<div class="bars">'+d.traffic.viewsPerDay14.map(function(x){
    return '<div class="bar" style="height:'+Math.round(x.views/max*100)+'%" title="'+esc(x.date)+': '+esc(x.views)+'"></div>';
  }).join('')+'</div>';

  h+='<h2>Language split (14d)</h2>'+rows(d.traffic.langSplit);
  h+='<h2>Top UTM sources (14d)</h2>'+rows(Object.fromEntries(d.traffic.topUtm.map(function(x){return [x.key,x.count];})));
  h+='<h2>Top referrers (14d)</h2>'+rows(Object.fromEntries(d.traffic.topReferrers.map(function(x){return [x.key,x.count];})));
  h+='<h2>Top countries (14d)</h2>'+rows(Object.fromEntries(d.traffic.topCountries.map(function(x){return [x.key,x.count];})));

  h+='<h2>Funnel (7d)</h2>';
  h+='<div class="row"><span>Views</span><span>'+esc(d.funnel7d.views)+'</span></div>';
  h+='<div class="row"><span>Buy clicks</span><span>'+esc(d.funnel7d.buys)+' ('+esc(d.funnel7d.dropoffViewsToBuys)+'% drop-off)</span></div>';
  h+='<div class="row"><span>Waitlist signups</span><span>'+esc(d.funnel7d.signups)+' ('+esc(d.funnel7d.dropoffViewsToSignups)+'% drop-off)</span></div>';
  h+='<h2>Buy clicks by source (14d)</h2>'+rows(d.traffic.buyBySrc);
  h+='<h2>Objections \u2014 exit survey (14d)</h2>'+rows(d.traffic.barriers);

  h+='<h2>Waitlist ('+esc(d.waitlist.length)+')</h2><table><tr><th>Email</th><th>Intent</th><th>Lang</th><th>UTM</th><th>Date</th><th>Shopify</th></tr>';
  d.waitlist.forEach(function(w){
    h+='<tr><td>'+esc(w.email)+'</td><td>'+esc(w.intent)+'</td><td>'+esc(w.lang)+'</td><td>'+esc(w.utm)+'</td><td>'+esc(w.ts)+'</td><td>'+(w.synced?'\\u2713':'\\u2717')+'</td></tr>';
  });
  h+='</table>';
  app.innerHTML=h;
}
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---- admin: routing --------------------------------------------------------------------------

async function handleLogin(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const hourBucket = new Date().toISOString().slice(0, 13);
  const failKey = `admin:fail:${ip}:${hourBucket}`;

  if (env.STATS) {
    const failCount = parseInt(await env.STATS.get(failKey), 10) || 0;
    if (failCount >= LOGIN_FAIL_LIMIT) return renderLogin(429);
  }

  let form;
  try { form = await request.formData(); } catch { return renderLogin(401); }
  const u = String(form.get('u') || '');
  const p = String(form.get('p') || '');

  let creds;
  try { creds = JSON.parse(env.ADMIN_CREDS); } catch { return new Response('admin not configured', { status: 503 }); }
  const user = (creds.users || []).find((x) => x.u === u);
  const ok = user ? await verifyPassword(p, user.salt, user.hash) : false;

  if (!ok) {
    if (env.STATS) {
      const failCount = (parseInt(await env.STATS.get(failKey), 10) || 0) + 1;
      await env.STATS.put(failKey, String(failCount), { expirationTtl: LOGIN_FAIL_WINDOW_SECONDS });
    }
    return renderLogin(401);
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const cookieVal = await signSession(exp, env.SESSION_SECRET);
  const headers = new Headers({ location: '/admin' });
  headers.append('set-cookie', `sess=${cookieVal}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  return new Response(null, { status: 303, headers });
}

function handleLogout() {
  const headers = new Headers({ location: '/admin' });
  headers.append('set-cookie', 'sess=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0');
  return new Response(null, { status: 303, headers });
}

async function handleAdmin(request, env, url) {
  if (!env.ADMIN_CREDS || !env.SESSION_SECRET) {
    return new Response('admin not configured', { status: 503 });
  }
  const path = url.pathname;

  if (path === '/admin/login' && request.method === 'POST') return handleLogin(request, env);
  if (path === '/admin/logout' && request.method === 'POST') return handleLogout();

  const cookie = getCookie(request, 'sess');
  const authed = await verifySession(cookie, env.SESSION_SECRET);
  if (!authed) return renderLogin(401);

  if (path === '/admin' && request.method === 'GET') return renderDashboard();
  if (path === '/admin/api/summary' && request.method === 'GET') return json(await buildSummary(env));
  if (path === '/admin/waitlist.csv' && request.method === 'GET') {
    const csv = toCsv(await loadWaitlist(env));
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="waitlist.csv"',
        'cache-control': 'no-store',
      },
    });
  }
  return new Response('not found', { status: 404 });
}

// ---- worker entrypoint ------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, url);
    }

    if (url.pathname === '/api/votes') {
      if (request.method === 'GET') return json(await readTally(env));
      if (request.method === 'POST') {
        if (!env.VOTES) return json({ error: 'KV namespace VOTES not bound' }, 500);
        let body; try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const pick = CONCEPTS.includes(body.pick) ? body.pick : null;
        const prev = CONCEPTS.includes(body.prev) ? body.prev : null;
        const tally = await readTally(env);
        if (prev && tally[prev] > 0) tally[prev] -= 1;
        if (pick) tally[pick] += 1;
        await env.VOTES.put(KEY, JSON.stringify(tally));
        if (pick) ctx.waitUntil(incrKV(env, counterKey(dateUTC(), 'votes')));
        return json(tally);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/api/ping') {
      // Zero-JS delivery telemetry: <img> pings from fragment (k=frag) and app.js first line (k=exec)
      const k = ['frag', 'exec'].includes(url.searchParams.get('k')) ? url.searchParams.get('k') : 'other';
      ctx.waitUntil(incrKV(env, counterKey(dateUTC(), 'diag', k)));
      return new Response(new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]), { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/shopify-embed/app.js') {
      // Serve via worker to count delivery (diag:served) with revalidation headers
      ctx.waitUntil(incrKV(env, counterKey(dateUTC(), 'diag', 'served')));
      const r = await env.ASSETS.fetch(request);
      const h = new Headers(r.headers);
      h.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(r.body, { status: r.status, headers: h });
    }

    if (url.pathname === '/embed/body') {
      // Body fragment for the Shopify page shell (tataoro.com/pages/cafe) — CORS read required
      const r = await env.ASSETS.fetch(new Request(new URL('/shopify-embed/body.html', url.origin)));
      const h = new Headers(r.headers);
      h.set('access-control-allow-origin', 'https://tataoro.com');
      h.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(r.body, { status: r.status, headers: h });
    }

    if (url.pathname === '/api/click') {
      const clickCors = {
        'access-control-allow-origin': 'https://tataoro.com',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: clickCors });
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const clickOrigin = request.headers.get('origin');
      const clickWithCors = (resp) => {
        if (clickOrigin === 'https://tataoro.com') {
          const h = new Headers(resp.headers);
          for (const [k, v] of Object.entries(clickCors)) h.set(k, v);
          return new Response(resp.body, { status: resp.status, headers: h });
        }
        return resp;
      };
      let body; try { body = await request.json(); } catch { return clickWithCors(json({ error: 'invalid json' }, 400)); }
      const date = dateUTC();
      if (body.kind === 'barrier') {
        const allowed = ['country', 'shipping', 'price', 'wholebean'];
        if (!allowed.includes(body.value)) return clickWithCors(json({ error: 'unknown barrier' }, 400));
        ctx.waitUntil(incrKV(env, counterKey(date, 'barrier', body.value)));
        return clickWithCors(json({ ok: true }));
      }
      if (body.kind === 'buy') {
        const src = body.src === 'sticky' ? 'sticky' : 'landing';
        ctx.waitUntil(Promise.all([
          incrKV(env, counterKey(date, 'buy')),
          incrKV(env, counterKey(date, 'buysrc', src)),
        ]));
        return clickWithCors(json({ ok: true }));
      }
      if (body.kind === 'view') {
        // Views arrive via page-load beacon: asset-matched requests never invoke
        // the worker (no run_worker_first), so server-side counting cannot see them.
        const page = PAGES.includes(body.page) ? body.page : null;
        if (!page) return clickWithCors(json({ error: 'unknown page' }, 400));
        const tasks = [incrKV(env, counterKey(date, 'views', page))];
        if (body.lang === 'en' || body.lang === 'es') tasks.push(incrKV(env, counterKey(date, 'lang', body.lang)));
        if (typeof body.utm === 'string' && body.utm) tasks.push(incrKV(env, counterKey(date, 'utm', body.utm.slice(0, 40))));
        if (typeof body.ref === 'string' && body.ref && body.ref !== url.host) tasks.push(incrKV(env, counterKey(date, 'ref', body.ref.slice(0, 60))));
        const country = request.cf && request.cf.country;
        if (country) tasks.push(incrKV(env, counterKey(date, 'country', country)));
        ctx.waitUntil(Promise.all(tasks));
        return clickWithCors(json({ ok: true }));
      }
      return clickWithCors(json({ error: 'unknown kind' }, 400));
    }

    if (url.pathname === '/api/notify') {
      // CORS for the Shopify pilot page (tataoro.com/pages/cafe)
      const corsHeaders = {
        'access-control-allow-origin': 'https://tataoro.com',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const origin = request.headers.get('origin');
      const withCors = (resp) => {
        if (origin === 'https://tataoro.com') {
          const h = new Headers(resp.headers);
          for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
          return new Response(resp.body, { status: resp.status, headers: h });
        }
        return resp;
      };
      if (!env.WAITLIST) return json({ error: 'KV namespace WAITLIST not bound' }, 500);
      let body; try { body = await request.json(); } catch { return withCors(json({ error: 'invalid json' }, 400)); }
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        return withCors(json({ error: 'invalid email' }, 400));
      }
      const record = {
        email,
        intent: body.intent === 'general' ? 'general' : 'whole-bean',
        lang: body.lang === 'es' ? 'es' : 'en',
        utm: typeof body.utm === 'string' ? body.utm.slice(0, 512) : '',
        ts: new Date().toISOString(),
        synced_to_shopify: false,
      };
      // Idempotent per email: re-signup refreshes the record, never duplicates.
      await env.WAITLIST.put('waitlist:' + email, JSON.stringify(record));
      ctx.waitUntil(incrKV(env, counterKey(dateUTC(), 'signups')));
      return withCors(json({ ok: true }));
    }

    // Not an API/admin route → static assets handle it.
    return env.ASSETS.fetch(request);
  },
};

export {
  sha256Hex,
  hmacSha256Hex,
  timingSafeEqual,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  dateUTC,
  counterKey,
  pageForPath,
  detectLang,
  externalRefHost,
  lastNDates,
  toCsv,
};
