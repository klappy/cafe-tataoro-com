// cafe.tataoro.com — Workers app: static assets + shared bakeoff vote tally.
// Static assets are served by the [assets] binding. This Worker only handles /api/votes;
// everything else falls through to the static site. If VOTES KV is unbound, the page
// still works in device-local mode (the client falls back gracefully).
const KEY = 'tally';
const CONCEPTS = ['A', 'B', 'C'];
const EMPTY = { A: 0, B: 0, C: 0 };
const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
async function readTally(env) {
  if (!env.VOTES) return { ...EMPTY };
  const raw = await env.VOTES.get(KEY);
  if (!raw) return { ...EMPTY };
  try { const v = JSON.parse(raw); return { A: v.A|0, B: v.B|0, C: v.C|0 }; } catch { return { ...EMPTY }; }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
        return json(tally);
      }
      return json({ error: 'method not allowed' }, 405);
    }
    // Not an API route → static assets handle it.
    return env.ASSETS.fetch(request);
  },
};
