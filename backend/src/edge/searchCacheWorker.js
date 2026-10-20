/**
 * Cloudflare Worker: edge cache for public search.
 * Normalizes the query so equivalent searches share one cache entry, then caches the
 * origin response via the Cache API (s-maxage=60, stale-while-revalidate=300).
 * Caches only complete result sets; paginated responses keep private origin sessions.
 * Deploy separately; ORIGIN is a Worker environment variable.
 */
export const normalizeQuery = (q) => String(q || '').trim().toLowerCase().split(/\s+/).sort().join(' ');

function parseBody(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function stripSessionId(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed.sessionId) {
      delete parsed.sessionId;
      // Complete public results can be shared without an origin session.
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
    if (request.method !== 'GET' || url.pathname !== '/api/search' || url.searchParams.has('sessionId')) {
      return fetch(new Request(env.ORIGIN + url.pathname + url.search, request));
    }
    const params = new URLSearchParams(url.searchParams);
    params.set('q', normalizeQuery(params.get('q')));
    params.sort();
    const cacheKey = new Request(`${url.origin}${url.pathname}?${params}`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      // Ignore entries from older deployments that lost their pagination session.
      if (parseBody(body)?.hasMore === false) {
        const res = new Response(stripSessionId(body), hit);
        res.headers.delete('Content-Length');
        res.headers.set('X-Cache', 'HIT');
        res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
        return res;
      }
    }

    const originRes = await fetch(`${env.ORIGIN}${url.pathname}?${params}`);
    if (!originRes.ok) return originRes;

    const body = await originRes.text();
    if (parseBody(body)?.hasMore !== false) {
      const res = new Response(body, originRes);
      res.headers.set('Cache-Control', 'private, no-store');
      res.headers.set('X-Cache', 'BYPASS');
      return res;
    }
    // A complete result set needs no continuation session and is safe to share.
    const strippedBody = stripSessionId(body);
    const res = new Response(strippedBody, originRes);
    res.headers.delete('Content-Length');
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.headers.set('X-Cache', 'MISS');
    ctx.waitUntil(cache.put(cacheKey, new Response(strippedBody, res)));
    return res;
  },
};
