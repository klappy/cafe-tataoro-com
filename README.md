# cafe-tataoro-com

Café Tata Oro — landing-page **bakeoff** for `cafe.tataoro.com`. Static site (no build step) served by a Cloudflare **Workers** app, with an optional shared vote tally.

## Structure

```
public/            static site (self-contained single-file pages)
  index.html       PRODUCTION landing page (canon brand-guide §12 blueprint; Shopify cart-permalink checkout)
  bakeoff.html     the retired bakeoff + voting (preserved)
  concept-a.html   Editorial Romance
  concept-b.html   Luxe Minimal · Product Hero
  concept-c.html   Warm Ritual · Bilingual
  assets/          product photos + og-image
src/worker.js      serves public/ via [assets]; adds GET/POST /api/votes when VOTES KV is bound
wrangler.jsonc     Worker + assets config
```

## Deploy (git-hook / Workers Build)

Connect this repo to the `cafe-tataoro-com` Worker in the Cloudflare dashboard
(Workers & Pages → the Worker → Settings → Build → connect repo). No build command; deploy on push to `main`.

## Voting

- **Out of the box:** votes are per-device (localStorage). The page works with no backend and shows an "offline" label — nothing to configure.
- **Shared live tally:** enabled — KV namespace `romance_bakeoff_votes` (`221d5e24388b4c53aa4e5c836d7f811a`) is bound as `VOTES` in `wrangler.jsonc`. The Worker's `/api/votes` GET/POST drives a shared count. Votes still fall back to per-device if the binding is ever removed.

## Status (2026-07-31)

Resolved: price ruled **$27.99** (captain 2× ruling + Tatiana feel-check); buy buttons wired to real
Shopify cart permalinks (Ground variant `49618530697368`, Whole Bean `49618614714520`, product
`9317298208920` on tataoro.com); `og:image` added.

## Open items

- Tatiana's review of the assembled page (copy is canon-ratified strings only, but copy-in-context is her gate).
- Tasting-note section intentionally omitted — canon §11 marks tasting notes DRAFT pending roaster + Tatiana.
- Full EN/ES toggle (footer carries the ratified ES boilerplate; full translation is a follow-up).
- QR/UTM scheme for the insert card (`utm_medium=card` suggested).
