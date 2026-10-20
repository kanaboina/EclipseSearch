/**
 * Cloudflare Worker: edge cache for public search.
 * Normalizes the query so equivalent searches share one cache entry, then caches the
 * origin response via the Cache API (s-maxage=60, stale-while-revalidate=300).
 * Strips sessionId from cached responses to prevent session sharing across users.
 * Deploy separately; ORIGIN is a Worker environment variable.
 */
export const normalizeQuery = (q) => String(q || '').trim().toLowerCase().split(/\s+/).sort().join(' ');

function stripSessionId(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed.sessionId) {
      delete parsed.sessionId;
      // Mark as cache-served so client knows to re-request if they need a session
      parsed.fromCache = true;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

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
    if (hit) {
      // Serve cached response but strip sessionId to prevent cross-user session sharing
      const body = await hit.text();
      const strippedBody = stripSessionId(body);
      const res = new Response(strippedBody, hit);
      res.headers.set('X-Cache', 'HIT');
      res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res;
    }

    const originRes = await fetch(`${env.ORIGIN}${url.pathname}?${params}`);
    if (!originRes.ok) return originRes;

    // Cache the response body without sessionId
    const body = await originRes.text();
    const strippedBody = stripSessionId(body);
    const res = new Response(strippedBody, originRes);
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.headers.set('X-Cache', 'MISS');
    ctx.waitUntil(cache.put(cacheKey, new Response(strippedBody, res)));
    return res;
  },
};
