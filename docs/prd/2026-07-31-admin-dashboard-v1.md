# PRD — cafe.tataoro.com Admin Dashboard v1

**Status:** ratified (captain direction 2026-07-31: D1a worker-native login, D2 amended
to KV counters after Analytics Engine token constraint surfaced). **v1.1 amendment
(captain ruling 2026-07-31): the bakeoff is retired — dashboard drops the bakeoff
section; funnel is views → signups. Vote plumbing stays dormant server-side.** **v1.2 amendment (captain ruling
2026-07-31): buy-click conversion tracking — beacon on both buy buttons (landing +
sticky) to POST /api/click, daily counters `d:<date>:buy` and `d:<date>:buysrc:<src>`,
dashboard gains Buy clicks (7d), View→buy %, funnel stage views→buy clicks, and a
by-source table. Conversion rate is the paramount metric.** **v1.3 amendment (2026-08-01): view
counting moved to a page-load beacon (kind 'view' on /api/click) — asset-matched
requests never invoke the worker (no run_worker_first), so server-side pageview
recording was structurally blind; it is removed. Beacon carries page/lang/utm/ref;
country still derives server-side from request.cf. Side effect: non-JS crawlers no
longer inflate views.** **v1.4 amendment (captain ruling 2026-08-01): (a) Coffee-only
segmentation — cafe signups live in their own KV waitlist and sync to Shopify customers
with tags `coffee`, `cafe-waitlist` + intent tag; hair campaigns exclude `tag:coffee`;
cafe page never uses the store newsletter form. (b) Exit-intent survey on the Shopify
pilot page: one question ("what's holding you back"), four barrier options
(country/shipping/price/wholebean), each answered with a straight, reverse-psychology
close driving to buy or the whole-bean list. Barrier picks beacon to /api/click
kind=barrier and surface on the dashboard as "Objections (14d)". Per-cup math ruling:
compute at a 250 ml home mug, never the 150 ml box "cup" ($27.99/340 g ≈ 22 cups
≈ $1.30/cup).** **Mode chain:**
exploration → this PRD → execution flight.

## Goal

Give the two owners (klappy + Tata) a private `/admin` dashboard on the existing
`cafe-tataoro-com` worker showing everything the bakeoff site learns from visitors,
so landing-page and sales decisions are made from observed behavior, not guesses.

## Users & auth (D1a — worker-native)

- Two users: `klappy`, `tata`. Credentials live in worker secret `ADMIN_CREDS`:
  JSON `{"users":[{"u":"<name>","salt":"<hex>","hash":"<hex sha256(salt+password)>"}]}`.
- `GET /admin` unauthenticated → minimal login form (POST `/admin/login`,
  fields `u`, `p`). On success set cookie `sess=<exp>.<hmac-sha256(exp, SESSION_SECRET)>`,
  HttpOnly, Secure, SameSite=Lax, Path=/admin, 30-day expiry. Constant-time compare.
- Failed logins: per-IP counter in STATS KV, soft lock (429) after 10 fails/hour.
- `POST /admin/logout` clears cookie. No password change flow in v1 (rotation =
  captain asks seat to reset secret).
- All `/admin/*` routes except login require a valid cookie; invalid → login form.

## Instrumentation (D2 v1 — KV counters, Analytics Engine deferred)

New KV binding `STATS` (namespace `cafe-tataoro-stats`, created at deploy).
Non-blocking (`ctx.waitUntil`) writes; low-traffic read-modify-write accepted for v1.

Daily counter keys, all UTC dates:
- `d:<YYYY-MM-DD>:views:<page>` — page ∈ {index, concept-a, concept-b, concept-c, bakeoff}
  on HTML GETs (skip /admin, skip assets).
- `d:<YYYY-MM-DD>:lang:<en|es>` — from `?lang=` param or `accept-language` prefix.
- `d:<YYYY-MM-DD>:utm:<source>` — first 40 chars of `utm_source` when present.
- `d:<YYYY-MM-DD>:ref:<host>` — referrer host (max 60 chars) when external.
- `d:<YYYY-MM-DD>:country:<CC>` — from `request.cf.country`.
- `d:<YYYY-MM-DD>:votes` and `d:<YYYY-MM-DD>:signups` — incremented inside the
  existing POST handlers (funnel events).
Retention: keys carry 400-day TTL.

## Dashboard content (`GET /admin`, authenticated)

Single self-contained HTML page rendered from the worker (inline CSS/JS, no new
static assets — deploy uses keep_assets). Mobile-first; Tata reads this on a phone.

1. **Topline cards:** total waitlist size, signups last 7 days, total views last
   7 days, view→signup conversion % (7d).
2. **Waitlist table:** every KV `waitlist:*` record — email, intent, lang, UTM,
   date, Shopify-sync ✓/✗. Newest first. `GET /admin/waitlist.csv` (auth-gated)
   exports the same.
3. **Bakeoff:** A/B/C vote tally (existing VOTES KV) + per-concept views (7d and
   all-recorded) + votes-per-100-views per concept.
4. **Traffic (last 14 days):** views/day sparkline or bar (inline SVG or plain
   HTML bars — no external JS libraries), language split, top UTM sources, top
   referrers, top countries.
5. **Funnel (7d):** views → votes → signups with drop-off percentages.
All data reads via a single auth-gated `GET /admin/api/summary` JSON endpoint the
page fetches; KV list+get fan-out server-side.

## Non-goals (v1)

Analytics Engine, email sending, password self-service, per-visitor identity,
cookie consent banners (no third-party trackers added), editing waitlist entries.

## Constraints

- Existing public routes and behavior byte-identical except added stat writes.
- No new npm dependencies; single-file `src/worker.js` stays single-file; WebCrypto only.
- `wrangler.jsonc` gains the STATS binding with namespace id supplied at deploy
  (placeholder `__STATS_KV_ID__` acceptable in the PR; seat substitutes real id
  before deploy — or seat provides the id in the brief).
- Secrets (`ADMIN_CREDS`, `SESSION_SECRET`) are set by the dispatch seat post-merge,
  never committed. Code must read them from `env`.

## Definition of done

1. PR against `main` implementing all of the above, single worker file + wrangler
   binding + this PRD referenced in the PR body.
2. Local logic sanity: a Node-based smoke test file `test/smoke.mjs` exercising
   auth hash/verify + cookie sign/verify + counter key derivation (pure functions
   exported from worker or duplicated minimal module), run green in the flight.
3. Fresh-context validation verdict VERIFIED against THIS PRD.
4. (Seat, post-merge) deployed with keep_assets; live checks: public pages serve,
   `/admin` gates, login works for both users, summary renders.
