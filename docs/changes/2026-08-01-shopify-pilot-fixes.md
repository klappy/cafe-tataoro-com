# Change summary — Shopify cafe page pilot fixes (2026-08-01)

Board item: `tataoro-shopify-cafe-pilot`. All changes deployed via merge-to-main
(Workers Builds); page served as embed shell at tataoro.com/pages/cafe (+ /cafe 301).

| PR | SHA | What | Why (captain report) |
|----|-----|------|----------------------|
| #11 | 316ff6d | Exit survey (4 barriers, EN/ES) + barrier counters + Objections dashboard | Coffee-only signup segmentation ruling + reverse-psych objection handling |
| #12 | 787462f | Embed lane: git-served body fragment + app.js, /embed/body CORS route | Page must render with no theme publish or preview params |
| #13 | 4004968 | Buy flow → cart page (cart/add + return_to) all surfaces; body,body.gradient bg override | Buy went straight to checkout; page illegible (theme specificity) |
| #14 | 90d8191 | Reparent .lang-pill/.sticky-bar/.exit-veil to body; neutralize wrapper slide-in | No sticky bar; survey blur without card (transform containment) |
| #15 | 67c3b95 | Strip .rte class at init + scoped palette override layer | Purple text/outlines, labels collapsed onto fields (.rte styles) |

## Validation receipts
`validation/2026-08-01/*.png` — puppeteer, 390×844 mobile, LIVE urls, 15:49–15:51Z:
shopify vs subdomain top/buy/footer (palette + layout parity, sticky bar pinned),
survey card visible over blur, price answer panel with $1.30/cup math.

Open cosmetic: extra top padding above hero vs reference (flagged, awaiting ruling).
Open captain gates: survey copy review (brand voice); pilot theme deletion in admin.
