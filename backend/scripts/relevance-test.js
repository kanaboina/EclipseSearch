#!/usr/bin/env node
// ============================================================================
// Eclipse Search – Relevance Test Suite
// ============================================================================
// Usage:
//   node scripts/relevance-test.js                       # basic run
//   node scripts/relevance-test.js --json                # machine-readable output
//   node scripts/relevance-test.js --save baseline       # save results as "baseline"
//   node scripts/relevance-test.js --compare baseline    # compare current run to saved "baseline"
//   node scripts/relevance-test.js --k 20                # evaluate at cutoff K=20
//
// The script boots the search engine in-process (no HTTP needed), so it
// works against the 10k mock catalog out of the box. If MONGODB_URI is set,
// it will test against the live Atlas cluster instead.
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const { setupSearchEngine } = require('../src/server');

// ── CLI flags ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? (args[i + 1] || true) : null; };
const K       = parseInt(flag('k'), 10) || 10;
const asJson  = args.includes('--json');
const saveName   = flag('save');
const compareTo  = flag('compare');
const RESULTS_DIR = path.join(__dirname, '..', 'relevance-results');

// ── Colors (disable in CI / piped output) ───────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold:  isTTY ? '\x1b[1m' : '',
  dim:   isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow:isTTY ? '\x1b[33m' : '',
  red:   isTTY ? '\x1b[31m' : '',
  cyan:  isTTY ? '\x1b[36m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
};

// ── Golden Set ──────────────────────────────────────────────────────────────
// Each query has:
//   q:        the search string (including deliberate typos where noted)
//   mustHave: words that MUST appear in title/tags/category/style for grade 2
//   related:  weaker relevance signals worth grade 1
//   note:     what this query specifically tests
//
// The golden set is designed around the BASE_WORDS and generated vocabulary
// in datasetGenerator.js so it works against the 10k mock catalog.
const GOLDEN = [
  // ── Exact single-word matches ──────────────────────────────────────────
  { q: 'dragon',
    mustHave: ['dragon'], related: ['drake', 'wyvern', 'fire', 'flame'],
    note: 'core exact match' },
  { q: 'samurai',
    mustHave: ['samurai'], related: ['katana', 'warrior', 'blade', 'ninja'],
    note: 'core exact match' },
  { q: 'phoenix',
    mustHave: ['phoenix'], related: ['flame', 'fire', 'rebirth', 'ember'],
    note: 'core exact match' },
  { q: 'cyberpunk',
    mustHave: ['cyberpunk'], related: ['neon', 'cyber', 'metropolis', 'hacker'],
    note: 'core exact match + category/style' },
  { q: 'valkyrie',
    mustHave: ['valkyrie'], related: ['warrior', 'angel', 'celestial', 'shield'],
    note: 'core exact match' },

  // ── Multi-word queries ─────────────────────────────────────────────────
  { q: 'dragon knight',
    mustHave: ['dragon', 'knight'], related: ['warrior', 'armor', 'castle', 'blade'],
    note: 'multi-token, both should match' },
  { q: 'cyberpunk neon',
    mustHave: ['cyberpunk', 'neon'], related: ['city', 'night', 'metropolis', 'alleyway'],
    note: 'multi-token style+atmosphere' },
  { q: 'samurai sunset',
    mustHave: ['samurai', 'sunset'], related: ['katana', 'warrior', 'dusk', 'dawn'],
    note: 'multi-token character+scene' },
  { q: 'crystal cavern',
    mustHave: ['crystal', 'cavern'], related: ['gem', 'cave', 'dungeon', 'rune'],
    note: 'multi-token setting' },
  { q: 'shadow wolf',
    mustHave: ['shadow', 'wolf'], related: ['beast', 'dark', 'night', 'hunter'],
    note: 'multi-token creature' },

  // ── Typo tolerance ─────────────────────────────────────────────────────
  { q: 'draogn',
    mustHave: ['dragon'], related: ['drake', 'wyvern', 'fire'],
    note: 'typo: transposition' },
  { q: 'samuari',
    mustHave: ['samurai'], related: ['katana', 'warrior', 'ninja'],
    note: 'typo: transposition' },
  { q: 'cybepunk',
    mustHave: ['cyberpunk'], related: ['neon', 'cyber', 'metropolis'],
    note: 'typo: missing letter' },
  { q: 'phenix',
    mustHave: ['phoenix'], related: ['flame', 'fire', 'ember'],
    note: 'typo: missing letter' },
  { q: 'wizrd',
    mustHave: ['wizard'], related: ['mage', 'sorcerer', 'staff', 'grimoire'],
    note: 'typo: missing vowel' },

  // ── Category / Style targeting ─────────────────────────────────────────
  { q: 'fantasy',
    mustHave: ['fantasy'], related: ['dragon', 'castle', 'warrior', 'elf', 'mage'],
    note: 'category name match' },
  { q: 'anime',
    mustHave: ['anime'], related: ['sakura', 'warrior', 'ninja'],
    note: 'category/style match' },
  { q: 'sci-fi',
    mustHave: ['sci-fi'], related: ['spaceship', 'planet', 'galaxy', 'mech'],
    note: 'category match with hyphen' },

  // ── Semantic expansion ─────────────────────────────────────────────────
  { q: 'sword',
    mustHave: ['sword'], related: ['blade', 'katana', 'warrior', 'knight'],
    note: 'expansion should surface blade/katana' },
  { q: 'forest',
    mustHave: ['forest'], related: ['woods', 'tree', 'oak', 'pine', 'willow', 'nature'],
    note: 'expansion should surface nature terms' },
  { q: 'night sky',
    mustHave: ['night', 'sky'], related: ['star', 'moon', 'midnight', 'celestial', 'aurora'],
    note: 'expansion for atmospheric scene' },
  { q: 'flame',
    mustHave: ['flame'], related: ['fire', 'ember', 'phoenix', 'ash', 'spark'],
    note: 'expansion for fire-adjacent' },
  { q: 'ocean',
    mustHave: ['ocean'], related: ['sea', 'wave', 'mermaid', 'siren', 'tide'],
    note: 'expansion for water domain' },

  // ── Edge cases ─────────────────────────────────────────────────────────
  { q: 'eclipse aurora nebula',
    mustHave: ['eclipse', 'aurora', 'nebula'], related: ['celestial', 'star', 'cosmic'],
    note: '3-token query, low intersection expected' },
  { q: 'steampunk fortress',
    mustHave: ['steampunk', 'fortress'], related: ['castle', 'citadel', 'gear', 'tower'],
    note: 'style + location cross-domain' },
];

// ── Scoring helpers ─────────────────────────────────────────────────────────

/** Grade a single result item against a golden query case. 2 = strong, 1 = related, 0 = miss */
function grade(item, golden) {
  // Flatten all textual signals from the API response shape
  const parts = [
    item.title,
    ...(item.tags || []),
    item.category?.name || '',
    item.category?.slug || '',
    item.style || '',
    item.excerpt || '',
  ];
  const text = parts.join(' ').toLowerCase();

  const mustHits = golden.mustHave.filter(w => text.includes(w.toLowerCase())).length;
  if (mustHits === golden.mustHave.length) return 2;    // full match
  if (mustHits > 0) return 1;                           // partial match
  if (golden.related.some(w => text.includes(w.toLowerCase()))) return 1;
  return 0;
}

/** DCG (Discounted Cumulative Gain) */
function dcg(grades) {
  return grades.reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
}

/** nDCG: normalized DCG against ideal ordering */
function ndcg(grades) {
  const ideal = [...grades].sort((a, b) => b - a);
  const idealDCG = dcg(ideal);
  return idealDCG > 0 ? dcg(grades) / idealDCG : 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║   Eclipse Search – Relevance Test Suite               ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚══════════════════════════════════════════════════════════╝${c.reset}\n`);

  // Boot the search engine in-process
  console.log(`${c.dim}Booting search engine...${c.reset}`);
  const engine = await setupSearchEngine();
  const { progressiveSearch, isAtlasLive } = engine;
  console.log(`${c.dim}Mode: ${isAtlasLive ? 'Atlas Live' : 'Mock 10k Catalog'}  |  K=${K}  |  Golden queries: ${GOLDEN.length}${c.reset}\n`);

  const queryResults = [];
  let totalP = 0, totalMRR = 0, totalNDCG = 0;

  for (const golden of GOLDEN) {
    const result = await progressiveSearch.search({ q: golden.q, limit: K });
    const items = result.data.slice(0, K);
    const grades = items.map(it => grade(it, golden));

    // Precision@K
    const p = grades.filter(g => g > 0).length / K;

    // MRR (Mean Reciprocal Rank)
    const firstRelevant = grades.findIndex(g => g > 0);
    const mrr = firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1);

    // nDCG@K
    const nDCGScore = ndcg(grades);

    totalP += p;
    totalMRR += mrr;
    totalNDCG += nDCGScore;

    // Status indicator
    const meanScore = (p + mrr + nDCGScore) / 3;
    const status = meanScore >= 0.7 ? `${c.green}✅ GOOD${c.reset}`
                 : meanScore >= 0.4 ? `${c.yellow}⚠️  OKAY${c.reset}`
                 : `${c.red}❌ WEAK${c.reset}`;

    const qr = {
      query: golden.q,
      note: golden.note,
      precision: p,
      mrr,
      ndcg: nDCGScore,
      grades,
      topTitles: items.slice(0, 5).map(i => i.title),
      status: meanScore >= 0.7 ? 'GOOD' : meanScore >= 0.4 ? 'OKAY' : 'WEAK',
      resultCount: items.length,
    };
    queryResults.push(qr);

    if (!asJson) {
      console.log(
        `${status}  ${c.bold}${golden.q.padEnd(25)}${c.reset} ` +
        `P@${K}=${c.cyan}${p.toFixed(2)}${c.reset}  ` +
        `MRR=${c.cyan}${mrr.toFixed(2)}${c.reset}  ` +
        `nDCG=${c.cyan}${nDCGScore.toFixed(2)}${c.reset}  ` +
        `${c.dim}grades=[${grades.join(',')}]${c.reset}  ` +
        `${c.dim}(${golden.note})${c.reset}`
      );
      if (p < 0.5) {
        console.log(`${c.red}     ↳ Top titles: ${items.slice(0, 5).map(i => `"${i.title}"`).join(' | ')}${c.reset}`);
      }
    }
  }

  const n = GOLDEN.length;
  const meanP    = totalP / n;
  const meanMRR  = totalMRR / n;
  const meanNDCG = totalNDCG / n;

  const scoreBand = (val, thresholds) =>
    val >= thresholds[1] ? `${c.green}${val.toFixed(3)}${c.reset}`
    : val >= thresholds[0] ? `${c.yellow}${val.toFixed(3)}${c.reset}`
    : `${c.red}${val.toFixed(3)}${c.reset}`;

  if (!asJson) {
    console.log(`\n${c.bold}${'─'.repeat(60)}${c.reset}`);
    console.log(`${c.bold}AGGREGATE SCORES (${n} queries, K=${K})${c.reset}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`  Mean P@${K}:     ${scoreBand(meanP, [0.4, 0.8])}     ${c.dim}(< 0.4 weak | 0.5–0.7 ok | > 0.8 good)${c.reset}`);
    console.log(`  Mean MRR:      ${scoreBand(meanMRR, [0.5, 0.9])}     ${c.dim}(< 0.5 weak | 0.6–0.8 ok | > 0.9 good)${c.reset}`);
    console.log(`  Mean nDCG@${K}:  ${scoreBand(meanNDCG, [0.6, 0.9])}     ${c.dim}(< 0.6 weak | 0.7–0.85 ok | > 0.9 good)${c.reset}`);
    console.log(`${'─'.repeat(60)}`);

    // Category breakdown
    const categories = {
      'Exact match':     queryResults.filter(r => r.note.includes('exact match')),
      'Multi-word':      queryResults.filter(r => r.note.includes('multi-token')),
      'Typo tolerance':  queryResults.filter(r => r.note.includes('typo')),
      'Category/Style':  queryResults.filter(r => r.note.includes('category') || r.note.includes('style')),
      'Expansion':       queryResults.filter(r => r.note.includes('expansion')),
      'Edge cases':      queryResults.filter(r => r.note.includes('edge') || r.note.includes('cross-domain') || r.note.includes('intersection')),
    };
    console.log(`\n${c.bold}BREAKDOWN BY QUERY TYPE${c.reset}`);
    for (const [cat, items] of Object.entries(categories)) {
      if (!items.length) continue;
      const avgP    = items.reduce((s, i) => s + i.precision, 0) / items.length;
      const avgMRR  = items.reduce((s, i) => s + i.mrr, 0) / items.length;
      const avgNDCG = items.reduce((s, i) => s + i.ndcg, 0) / items.length;
      console.log(
        `  ${cat.padEnd(18)} (${items.length} queries)  ` +
        `P@${K}=${scoreBand(avgP, [0.4, 0.8])}  MRR=${scoreBand(avgMRR, [0.5, 0.9])}  nDCG=${scoreBand(avgNDCG, [0.6, 0.9])}`
      );
    }

    // Weak query summary
    const weak = queryResults.filter(r => r.status === 'WEAK');
    if (weak.length) {
      console.log(`\n${c.red}${c.bold}⚠ ${weak.length} WEAK queries need attention:${c.reset}`);
      for (const w of weak) {
        console.log(`  ${c.red}• "${w.query}"${c.reset} ${c.dim}(${w.note})${c.reset} — P@${K}=${w.precision.toFixed(2)}`);
      }
    } else {
      console.log(`\n${c.green}${c.bold}✨ No weak queries — all ${n} golden queries performing at OKAY or better.${c.reset}`);
    }
  }

  // ── Save results ──────────────────────────────────────────────────────────
  const snapshot = {
    timestamp: new Date().toISOString(),
    mode: isAtlasLive ? 'atlas-live' : 'mock-10k',
    k: K,
    queryCount: n,
    meanPrecision: meanP,
    meanMRR,
    meanNDCG,
    queries: queryResults,
  };

  if (saveName) {
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const fp = path.join(RESULTS_DIR, `${saveName}.json`);
    fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
    console.log(`\n${c.green}✓ Results saved to ${fp}${c.reset}`);
  }

  // ── Compare to baseline ──────────────────────────────────────────────────
  if (compareTo) {
    const bp = path.join(RESULTS_DIR, `${compareTo}.json`);
    if (!fs.existsSync(bp)) {
      console.error(`${c.red}Baseline file not found: ${bp}${c.reset}`);
      console.error(`Run with --save ${compareTo} first to create a baseline.`);
    } else {
      const baseline = JSON.parse(fs.readFileSync(bp, 'utf-8'));
      console.log(`\n${c.bold}${c.magenta}A/B COMPARISON vs "${compareTo}"${c.reset}`);
      console.log(`${'─'.repeat(60)}`);

      const delta = (curr, base) => {
        const d = curr - base;
        const sign = d >= 0 ? '+' : '';
        const color = d > 0.02 ? c.green : d < -0.02 ? c.red : c.dim;
        return `${color}${sign}${d.toFixed(3)}${c.reset}`;
      };

      console.log(`  Mean P@${K}:     ${meanP.toFixed(3)}  (was ${baseline.meanPrecision.toFixed(3)}, Δ ${delta(meanP, baseline.meanPrecision)})`);
      console.log(`  Mean MRR:      ${meanMRR.toFixed(3)}  (was ${baseline.meanMRR.toFixed(3)}, Δ ${delta(meanMRR, baseline.meanMRR)})`);
      console.log(`  Mean nDCG@${K}:  ${meanNDCG.toFixed(3)}  (was ${baseline.meanNDCG.toFixed(3)}, Δ ${delta(meanNDCG, baseline.meanNDCG)})`);

      // Per-query comparison for queries that changed significantly
      console.log(`\n${c.bold}  Queries with significant changes (Δ nDCG > 0.1):${c.reset}`);
      let sigChanges = 0;
      for (const curr of queryResults) {
        const base = baseline.queries.find(b => b.query === curr.query);
        if (!base) continue;
        const dNDCG = curr.ndcg - base.ndcg;
        if (Math.abs(dNDCG) > 0.1) {
          sigChanges++;
          const arrow = dNDCG > 0 ? `${c.green}↑${c.reset}` : `${c.red}↓${c.reset}`;
          console.log(`    ${arrow} "${curr.query}": nDCG ${base.ndcg.toFixed(2)} → ${curr.ndcg.toFixed(2)} (${delta(curr.ndcg, base.ndcg)})`);
        }
      }
      if (!sigChanges) console.log(`    ${c.dim}(no significant per-query changes)${c.reset}`);
    }
  }

  // ── JSON mode ─────────────────────────────────────────────────────────────
  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
  }

  console.log(`\n${c.dim}Tip: run "node scripts/relevance-test.js --save before" before a change,`);
  console.log(`then "node scripts/relevance-test.js --compare before" after to see the delta.${c.reset}\n`);

  // Disconnect mongoose if connected
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  process.exit(0);
})();
