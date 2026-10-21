/**
 * Cloudflare Worker: cache the first public search page without a private session.
 * Clients follow nextPage with q + page; later pages and session requests go to origin.
 * Deploy separately; ORIGIN is a Worker environment variable.
 */
export const normalizeQuery = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');

function parseBody(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function isSearchPage(body) {
  return body && Array.isArray(body.data) && typeof body.hasMore === 'boolean';
}

function publicBody(parsed, fromCache, nextPage) {
  const body = { ...parsed, fromCache };
  delete body.sessionId;
  if (body.hasMore) body.nextPage = nextPage;
  else delete body.nextPage;
  return JSON.stringify(body);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originBase = String(env.ORIGIN).replace(/\/+$/, '');
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    if (request.method !== 'GET' || url.pathname !== '/api/search' || url.searchParams.has('sessionId') || page > 1) {
      return fetch(new Request(originBase + url.pathname + url.search, request));
    }
    const params = new URLSearchParams(url.searchParams);
    params.set('q', normalizeQuery(params.get('q')));
    params.delete('page'); // omitted page and page=1 share a key
    params.sort();
    const cacheKey = new Request(`${url.origin}${url.pathname}?${params}`, { method: 'GET' });
    const nextParams = new URLSearchParams(params);
    nextParams.set('page', '2');
    const nextPage = `${url.pathname}?${nextParams}`;
    const cache = caches.default;

    // Cache failures must not prevent an origin search.
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) {
      const parsed = parseBody(await hit.text());
      // Older nonterminal entries had no stateless continuation and are unusable.
      if (isSearchPage(parsed) && (!parsed.hasMore || parsed.nextPage === nextPage)) {
        const res = new Response(publicBody(parsed, true, nextPage), hit);
        res.headers.delete('Content-Length');
        res.headers.set('X-Cache', 'HIT');
        res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
        return res;
      }
    }

    // Force fixed rank windows for the first page too. Cursor refilling after a
    // withdrawal would overlap page 2 when the client continues without a session.
    const originParams = new URLSearchParams(params);
    originParams.set('page', '1');
    const originRes = await fetch(`${originBase}${url.pathname}?${originParams}`);
    if (!originRes.ok) return originRes;

    const body = await originRes.text();
    const parsed = parseBody(body);
    if (!isSearchPage(parsed)) {
      const res = new Response(body, originRes);
      res.headers.set('Cache-Control', 'private, no-store');
      res.headers.set('X-Cache', 'BYPASS');
      return res;
    }
    const strippedBody = publicBody(parsed, false, nextPage);
    const res = new Response(strippedBody, originRes);
    res.headers.delete('Content-Length');
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.headers.set('X-Cache', 'MISS');
    ctx.waitUntil(cache.put(cacheKey, new Response(strippedBody, res)).catch(() => {}));
    return res;
  },
};
