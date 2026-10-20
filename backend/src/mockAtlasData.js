const { generate10kWords, BASE_WORDS } = require('../scripts/datasetGenerator');
const { wallpaperCardDTO } = require('./utils/wallpaperDTO');
const { publicVisibilityFilter } = require('./utils/visibilityFilter');

const STYLES = ['fantasy', 'cyberpunk', 'anime', 'minimalist', 'scifi', 'nature', 'dark', 'abstract'];
const CATEGORIES = [
  { _id: 'cat_fan', name: 'Fantasy', slug: 'fantasy' },
  { _id: 'cat_sci', name: 'Sci-Fi', slug: 'sci-fi' },
  { _id: 'cat_ani', name: 'Anime', slug: 'anime' },
  { _id: 'cat_nat', name: 'Nature', slug: 'nature' },
  { _id: 'cat_gam', name: 'Gaming', slug: 'gaming' },
  { _id: 'cat_abs', name: 'Abstract', slug: 'abstract' },
];
const DEVICES = ['desktop', 'phone', 'tablet'];

/**
 * Generate 10,000 realistic wallpaper documents strictly matching
 * MongoDB Atlas collection schema and atlas-search index fields.
 */
function generate10kCatalog(size = 10000) {
  const words = generate10kWords();
  const docs = new Array(size);

  let seed = 424242;
  function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Inverted token index for fast Atlas Search simulation: token -> Set<docIndex>
  const tokenIndex = new Map();

  function indexToken(token, docIdx) {
    if (!token) return;
    const t = token.toLowerCase();
    let set = tokenIndex.get(t);
    if (!set) {
      set = new Set();
      tokenIndex.set(t, set);
    }
    set.add(docIdx);
  }

  for (let i = 0; i < size; i++) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 37 + 7) % words.length];
    const w3 = words[(i * 89 + 13) % words.length];
    const w4 = words[(i * 131 + 23) % words.length];
    const w5 = words[(i * 197 + 41) % words.length];

    const cat = CATEGORIES[i % CATEGORIES.length];
    const style = STYLES[(i * 3) % STYLES.length];
    const deviceType = DEVICES[i % 10 < 5 ? 0 : i % 10 < 9 ? 1 : 2]; // 50% desktop, 40% phone, 10% tablet
    const title = `${w1.charAt(0).toUpperCase() + w1.slice(1)} ${w2.charAt(0).toUpperCase() + w2.slice(1)} in ${w3}`;
    const slug = `${w1}-${w2}-${w3}-${i}`;
    const tags = [w1, w2, w3, w4, w5, style, cat.slug];
    const views = Math.floor(random() * 50000);
    const downloadsCount = Math.floor(views * (0.1 + random() * 0.4));
    const now = Date.now();

    // Generate valid 24-char hex ObjectId-like strings
    const objectIdHex = (i.toString(16).padStart(24, '0')).slice(-24);
    const doc = {
      _id: objectIdHex,
      title,
      slug,
      excerpt: `High-resolution 4k wallpaper depicting ${w1} and ${w2} infused with ${style} ambiance.`,
      style,
      story: `Ancient legends speak of ${w1} walking the realms of ${w2}...`,
      tags,
      categoryName: cat.name,
      category: cat,
      deviceType,
      status: 'published',
      deletionPending: false,
      publishAt: new Date(now - Math.floor(random() * 100000000)),
      views,
      downloadsCount,
      featured: i % 25 === 0,
      premium: i % 15 === 0,
      previewUrl: `https://images.eclipsefantasy.com/wallpapers/${slug}/preview.webp`,
      thumbnailUrl: `https://images.eclipsefantasy.com/wallpapers/${slug}/thumb.webp`,
      modalUrl: `https://images.eclipsefantasy.com/wallpapers/${slug}/modal.webp`,
      heroUrl: `https://images.eclipsefantasy.com/wallpapers/${slug}/hero.webp`,
      colors: ['#0f172a', '#38bdf8', '#818cf8'],
      width: 3840,
      height: 2160,
      createdAt: new Date(now - 100000000),
    };

    docs[i] = doc;

    // Index tokens for title, tags, style, category
    const titleTokens = title.toLowerCase().split(/\s+/);
    for (const t of titleTokens) indexToken(t, i);
    for (const tg of tags) indexToken(tg, i);
    indexToken(style, i);
    indexToken(cat.slug, i);
    indexToken(cat.name.toLowerCase(), i);
  }

  return { docs, tokenIndex, words };
}

/**
 * Fast in-memory Atlas Search pipeline simulator matching buildAtlasPipeline ranking.
 */
function createAtlasSearchSimulator({ docs, tokenIndex }) {
  return async function simulateAtlasSearch({ terms = [], rawTokens = [], deviceType, limit = 50, excludeIds = [] }) {
    const excludeSet = new Set(excludeIds.map(String));
    const candidateIndices = new Set();

    // Find candidate documents matching query tokens or expansion terms
    const allQueryTerms = [...rawTokens, ...terms.map((t) => t.term)];
    for (const term of allQueryTerms) {
      const docSet = tokenIndex.get(term.toLowerCase());
      if (docSet) {
        for (const idx of docSet) {
          candidateIndices.add(idx);
          if (candidateIndices.size >= 400) break; // Bounded candidate search pool
        }
      }
    }

    // If query terms produced few matches, fall back to sampling popular published docs
    if (candidateIndices.size < 20) {
      for (let i = 0; i < Math.min(200, docs.length); i++) {
        candidateIndices.add(i);
      }
    }

    const scored = [];
    for (const idx of candidateIndices) {
      const doc = docs[idx];
      if (doc.deletionPending || doc.status !== 'published') continue;
      if (deviceType && doc.deviceType !== deviceType) continue;
      if (excludeSet.has(doc._id)) continue;

      let score = 0;
      const lowerTitle = doc.title.toLowerCase();
      const tags = doc.tags;

      // 1. Raw token scoring (Title: 10, Tags: 8, Category: 7)
      for (const tok of rawTokens) {
        if (lowerTitle.includes(tok)) score += 10;
        if (tags.includes(tok)) score += 8;
        if (doc.categoryName.toLowerCase() === tok) score += 7;
      }

      // 2. Semantic expansion terms scoring (scaled by boost)
      for (const { term, boost } of terms) {
        if (lowerTitle.includes(term)) score += boost * 1.0;
        if (tags.includes(term)) score += boost * 0.8;
        if (doc.style === term) score += boost * 0.25;
      }

      scored.push({
        ...wallpaperCardDTO(doc),
        score,
        _searchScore: score,
        views: doc.views,
        downloadsCount: doc.downloadsCount,
      });
    }

    // Deterministic sort: _searchScore desc, views desc, downloads desc, _id asc
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.views !== a.views) return b.views - a.views;
      if (b.downloadsCount !== a.downloadsCount) return b.downloadsCount - a.downloadsCount;
      return a._id.localeCompare(b._id);
    });

    return scored.slice(0, limit);
  };
}

module.exports = {
  generate10kCatalog,
  createAtlasSearchSimulator,
};
