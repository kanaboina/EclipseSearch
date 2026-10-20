const nlp = require('compromise');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'into', 'over', 'under', 'his', 'her', 'their', 'our', 'your', 'my', 'he', 'she', 'they',
  'we', 'you', 'i', 'not', 'no', 'but', 'so', 'than', 'then', 'there', 'who', 'what', 'which',
  'has', 'have', 'had', 'will', 'would', 'can', 'could', 'up', 'out', 'about', 'one', 'all',
]);

// Domain stopwords carry a negligible miss penalty at query time.
const DOMAIN_STOPWORDS = new Set([
  'wallpaper', 'wallpapers', 'background', 'backgrounds', '4k', 'hd', '8k', '1080p', '1440p',
  'desktop', 'phone', 'image', 'images', 'picture', 'art', 'artwork',
]);

const NO_SINGULAR = /(ss|us|is|ous)$/;

function heuristicSingular(w) {
  if (NO_SINGULAR.test(w) || !w.endsWith('s')) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (/ves$/.test(w) && w.length > 4) return w.slice(0, -3) + 'f';
  return w.slice(0, -1);
}

function singularize(word) {
  const w = String(word).toLowerCase().trim();
  if (!w || w.length < 3 || /\d/.test(w)) return w;
  try {
    // Context ("the X") lets compromise tag the bare word as a noun.
    const out = nlp(`the ${w}`).nouns().toSingular().text().toLowerCase().replace(/^the\s+/, '').trim();
    if (out && !out.includes(' ') && out !== w) return out;
    if (out === w) return w;
  } catch (_) { /* fall through */ }
  return heuristicSingular(w);
}

function normalizeToken(raw) {
  const t = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  return t;
}

/** Strip hyphens entirely (for secondary matching). */
function normalizeTokenStrict(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Concatenate title + excerpt + story + tags; keep nouns, proper nouns, adjectives
 * (and every explicit tag token); singularize; strip stopwords. Returns unique words.
 */
function extractCleanWords({ title = '', excerpt = '', story = '', tags = [] } = {}) {
  const out = new Set();
  const add = (raw) => {
    const t = singularize(normalizeToken(raw));
    if (t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t)) out.add(t);
  };

  const prose = [title, excerpt, story].filter(Boolean).join('. ');
  if (prose.trim()) {
    const doc = nlp(prose);
    doc.match('(#Noun|#ProperNoun|#Adjective)').terms().forEach((term) => {
      add(term.text('normal'));
    });
  }
  for (const tag of tags || []) {
    String(tag).split(/\s+/).forEach(add);
  }
  return Array.from(out);
}

module.exports = { nlp, STOPWORDS, DOMAIN_STOPWORDS, singularize, normalizeToken, normalizeTokenStrict, extractCleanWords };
