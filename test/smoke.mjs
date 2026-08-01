// Node smoke test for src/worker.js pure helpers — no test framework deps beyond node:test.
// Run: node test/smoke.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  timingSafeEqual,
  dateUTC,
  counterKey,
  pageForPath,
  detectLang,
  externalRefHost,
  lastNDates,
  toCsv,
} from '../src/worker.js';

test('hashPassword / verifyPassword round-trip', async () => {
  const salt = 'a1b2c3';
  const hash = await hashPassword('correct horse battery staple', salt);
  assert.equal(hash.length, 64); // sha256 hex
  assert.equal(await verifyPassword('correct horse battery staple', salt, hash), true);
  assert.equal(await verifyPassword('wrong password', salt, hash), false);
});

test('verifyPassword rejects mismatched salt', async () => {
  const hash = await hashPassword('hunter2', 'salt-a');
  assert.equal(await verifyPassword('hunter2', 'salt-b', hash), false);
});

test('timingSafeEqual matches only identical strings', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('signSession / verifySession round-trip', async () => {
  const secret = 'top-secret';
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const cookie = await signSession(exp, secret);
  assert.match(cookie, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(await verifySession(cookie, secret), true);
});

test('verifySession rejects wrong secret, tampered signature, and expired cookies', async () => {
  const secret = 'top-secret';
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const cookie = await signSession(exp, secret);

  assert.equal(await verifySession(cookie, 'wrong-secret'), false);
  assert.equal(await verifySession(cookie.slice(0, -1) + '0', secret), false);

  const expired = await signSession(Math.floor(Date.now() / 1000) - 10, secret);
  assert.equal(await verifySession(expired, secret), false);

  assert.equal(await verifySession(null, secret), false);
  assert.equal(await verifySession('garbage', secret), false);
});

test('counterKey derivation', () => {
  assert.equal(counterKey('2026-07-31', 'views', 'index'), 'd:2026-07-31:views:index');
  assert.equal(counterKey('2026-07-31', 'lang', 'en'), 'd:2026-07-31:lang:en');
  assert.equal(counterKey('2026-07-31', 'votes'), 'd:2026-07-31:votes');
  assert.equal(counterKey('2026-07-31', 'signups'), 'd:2026-07-31:signups');
});

test('dateUTC formats to YYYY-MM-DD in UTC', () => {
  assert.equal(dateUTC(new Date('2026-07-31T23:59:59Z')), '2026-07-31');
  assert.equal(dateUTC(new Date('2026-01-01T00:00:00Z')), '2026-01-01');
});

test('lastNDates returns N consecutive UTC dates, most-recent first', () => {
  const dates = lastNDates(3, new Date('2026-07-31T12:00:00Z'));
  assert.deepEqual(dates, ['2026-07-31', '2026-07-30', '2026-07-29']);
});

test('pageForPath maps known routes and rejects unknown/admin paths', () => {
  assert.equal(pageForPath('/'), 'index');
  assert.equal(pageForPath('/index.html'), 'index');
  assert.equal(pageForPath('/concept-a'), 'concept-a');
  assert.equal(pageForPath('/bakeoff.html'), 'bakeoff');
  assert.equal(pageForPath('/admin'), null);
  assert.equal(pageForPath('/assets/og-image.png'), null);
});

test('detectLang prefers ?lang= then accept-language, else null', () => {
  const url1 = new URL('https://cafe.tataoro.com/?lang=es');
  assert.equal(detectLang(url1, new Request('https://cafe.tataoro.com/')), 'es');

  const url2 = new URL('https://cafe.tataoro.com/');
  const req2 = new Request('https://cafe.tataoro.com/', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assert.equal(detectLang(url2, req2), 'en');

  const url3 = new URL('https://cafe.tataoro.com/');
  const req3 = new Request('https://cafe.tataoro.com/', { headers: { 'accept-language': 'fr-FR' } });
  assert.equal(detectLang(url3, req3), null);
});

test('externalRefHost ignores same-host referrers', () => {
  const url = new URL('https://cafe.tataoro.com/concept-a');
  const external = new Request(url, { headers: { referer: 'https://instagram.com/p/abc' } });
  assert.equal(externalRefHost(external, url), 'instagram.com');

  const internal = new Request(url, { headers: { referer: 'https://cafe.tataoro.com/bakeoff' } });
  assert.equal(externalRefHost(internal, url), null);

  const none = new Request(url);
  assert.equal(externalRefHost(none, url), null);
});

test('toCsv escapes commas/quotes and formats the waitlist header', () => {
  const csv = toCsv([
    { email: 'a@example.com', intent: 'whole-bean', lang: 'en', utm: 'utm_source=ig', ts: '2026-07-31T00:00:00Z', synced_to_shopify: true },
    { email: 'b@example.com', intent: 'general', lang: 'es', utm: 'has,comma "and quote"', ts: '2026-07-30T00:00:00Z', synced_to_shopify: false },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'email,intent,lang,utm,date,synced_to_shopify');
  assert.equal(lines[1], 'a@example.com,whole-bean,en,utm_source=ig,2026-07-31T00:00:00Z,yes');
  assert.equal(lines[2], 'b@example.com,general,es,"has,comma ""and quote""",2026-07-30T00:00:00Z,no');
});
