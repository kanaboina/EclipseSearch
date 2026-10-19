/**
 * Cloudflare Worker: edge cache for public search.
 * Normalizes the query so equivalent searches share one cache entry, then caches the
 * origin response via the Cache API (s-maxage=60, stale-while-revalidate=300).
 * Deploy separately; ORIGIN is a Worker environment variable.
 */
export const normalizeQuery = (q) => String(q || '').trim().toLowerCase().split(/\s+/).sort().join(' ');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/search') || url.searchParams.has('sessionId')) {
      return fetch(new Request(env.ORIGIN + url.pathname + url.search, request));
    }
    const params = new URLSearchParams(url.searchParams);
    params.set('q', normalizeQuery(params.get('q')));
    params.sort();
    const cacheKey = new Request(`${url.origin}${url.pathname}?${params}`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const originRes = await fetch(`${env.ORIGIN}${url.pathname}?${params}`);
    if (!originRes.ok) return originRes;
    const res = new Response(originRes.body, originRes);
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
