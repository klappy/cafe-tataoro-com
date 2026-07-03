# cafe-tataoro-com

Café Tata Oro — landing-page **bakeoff** for `cafe.tataoro.com`. Static site (no build step) served by a Cloudflare **Workers** app, with an optional shared vote tally.

## Structure

```
public/            static site (self-contained single-file pages; React is pulled from unpkg at runtime)
  index.html       the bakeoff + voting
  concept-a.html   Editorial Romance
  concept-b.html   Luxe Minimal · Product Hero
  concept-c.html   Warm Ritual · Bilingual
src/worker.js      serves public/ via [assets]; adds GET/POST /api/votes when VOTES KV is bound
wrangler.jsonc     Worker + assets config
```

## Deploy (git-hook / Workers Build)

Connect this repo to the `cafe-tataoro-com` Worker in the Cloudflare dashboard
(Workers & Pages → the Worker → Settings → Build → connect repo). No build command; deploy on push to `main`.

## Voting

- **Out of the box:** votes are per-device (localStorage). The page works with no backend and shows an "offline" label — nothing to configure.
- **Shared live tally (optional):** create a KV namespace and bind it as `VOTES` (Production + Preview), then uncomment the `kv_namespaces` line in `wrangler.jsonc`. The Worker's `/api/votes` GET/POST then drives a shared count.

## Open items before this becomes the permanent storefront

- Prices in the concept pages are **draft** ($25 / $29) — confirm with Elkin before treating as final.
- Buy buttons are Shopify **placeholders** — wire real storefront token / product / variant IDs.
- Copy is **draft pending Tatiana's authorial-voice + brand-feel review** (per project canon).
- `og:image` points at `/assets/og-image.png` (not yet present) — add for social previews.
