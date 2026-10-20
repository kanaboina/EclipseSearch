const SemanticNode = require('../models/SemanticNode');
const AiIngestionJob = require('../models/AiIngestionJob');
const { memoryGraph, addEdges, linkDocToWords } = require('./memoryGraph');
const { neighborIndex } = require('./neighborIndex');
const { extractCleanWords } = require('./textNlp');

const TIMEOUT_MS = 10000;
const EDGES_PER_WORD = 20;
const RELATIONS = ['synonym', 'hyponym', 'hypernym', 'sibling', 'scene', 'mood', 'tangent'];

function buildPrompt(words) {
  return [
    'You build a semantic graph for a fantasy/anime wallpaper search engine.',
    `For EACH word below produce exactly ${EDGES_PER_WORD} related lowercase single-word terms.`,
    'Each edge: {"target": word, "weight": integer 1-6, "relation": one of',
    `${RELATIONS.join('|')}}.`,
    'Weights: 1 synonym/co-visual; 2 hypernym/hyponym; 3 sibling; 4 scene/aesthetic;',
    '5 mood/atmosphere; 6 distant tangential link.',
    'relation "hyponym" = target is a more specific child of the word (animal->dog);',
    'relation "hypernym" = target is a broader parent of the word (dog->animal).',
    'Return ONLY JSON: {"expansions": {"<word>": [edges...]}}.',
    `Words: ${JSON.stringify(words)}`,
  ].join('\n');
}

async function postJson(url, headers, body, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function defaultProviders(env = process.env, fetchImpl = fetch) {
  const providers = [];
  if (env.GEMINI_API_KEY) {
    providers.push({
      name: 'gemini-2.5-flash',
      call: async (prompt) => {
        const j = await postJson(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {},
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } },
          fetchImpl
        );
        return j.candidates[0].content.parts[0].text;
      },
    });
  }
  if (env.GROQ_API_KEY) {
    providers.push({
      name: 'groq-llama-3.3-70b',
      call: async (prompt) => {
        const j = await postJson(
          'https://api.groq.com/openai/v1/chat/completions',
          { Authorization: `Bearer ${env.GROQ_API_KEY}` },
          {
            model: 'llama-3.3-70b-versatile',
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
          },
          fetchImpl
        );
        return j.choices[0].message.content;
      },
    });
  }
  if (env.OPENAI_API_KEY) {
    providers.push({
      name: 'openai-gpt-4o-mini',
      call: async (prompt) => {
        const j = await postJson(
          'https://api.openai.com/v1/chat/completions',
          { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          {
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
          },
          fetchImpl
        );
        return j.choices[0].message.content;
      },
    });
  }
  return providers;
}

function sanitizeExpansions(parsed, words) {
  const src = (parsed && parsed.expansions) || {};
  const result = {};
  for (const word of words) {
    const raw = Array.isArray(src[word]) ? src[word] : null;
    if (!raw) continue;
    const seen = new Set();
    const edges = [];
    for (const e of raw) {
      const target = String((e && e.target) || '').toLowerCase().trim();
      const weight = Math.round(Number(e && e.weight));
      if (!/^[a-z0-9][a-z0-9 -]*$/.test(target) || target === word || seen.has(target)) continue;
      if (!(weight >= 1 && weight <= 6)) continue;
      const relation = RELATIONS.includes(e.relation) ? e.relation : 'synonym';
      seen.add(target);
      edges.push({ target, weight, relation });
      if (edges.length >= EDGES_PER_WORD) break;
    }
    if (edges.length) result[word] = edges;
  }
  return result;
}

/** Try each provider in order; returns sanitized expansions (may be partial). */
async function callLlmWithFallback(words, providers = defaultProviders()) {
  if (!providers.length) throw new Error('No AI providers configured');
  const prompt = buildPrompt(words);
  const errors = [];
  for (const p of providers) {
    try {
      const text = await p.call(prompt);
      const out = sanitizeExpansions(JSON.parse(text), words);
      const missing = words.filter((w) => !out[w]);
      return { expansions: out, missing };
    } catch (err) {
      errors.push(`${p.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

/** Global dedupe: only words never expanded before. */
async function findUnseenWords(words, Model = SemanticNode) {
  if (!words.length) return [];
  const BATCH_SIZE = 10000; // MongoDB $in limit safety margin
  const allDone = new Set();
  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const done = await Model.find({ word: { $in: batch }, isExpanded: true }).select('word').lean();
    done.forEach((d) => allDone.add(d.word));
  }
  return words.filter((w) => !allDone.has(w));
}

/** Upsert edges (bulkWrite unordered) and hot-update the in-memory graph. */
async function persistExpansionsToGraph(expansions, { Model = SemanticNode, graph = memoryGraph, index = neighborIndex } = {}) {
  const ops = Object.entries(expansions).map(([word, edges]) => ({
    updateOne: {
      filter: { word },
      update: { $set: { isExpanded: true, edges }, $setOnInsert: { word } },
      upsert: true,
    },
  }));
  if (ops.length) await Model.bulkWrite(ops, { ordered: false });
  for (const [word, edges] of Object.entries(expansions)) addEdges(graph, word, edges);
  // Write-time only: refresh precomputed neighbor caches for the touched region.
  if (index) index.update(graph, Object.keys(expansions));
}

async function expandWords(words, deps = {}) {
  const unseen = await findUnseenWords(words, deps.Model);
  if (!unseen.length) return { expanded: [], unseen: [], missing: [] };

  let allExpanded = [];
  let remaining = unseen;
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries && remaining.length; attempt++) {
    const { expansions, missing } = await callLlmWithFallback(remaining, deps.providers);
    const expanded = Object.keys(expansions);
    if (expanded.length) {
      await persistExpansionsToGraph(expansions, deps);
      allExpanded.push(...expanded);
    }
    remaining = missing;
    if (remaining.length && attempt < maxRetries - 1) {
      // Small delay before retrying missing words
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { expanded: allExpanded, unseen, missing: remaining };
}

/**
 * Persist the document-to-word mapping into the SemanticNode collection
 * (adds docId to each word's `docIds` posting list, idempotent via $addToSet)
 * and hot-updates the in-memory wordDocIds map.
 *
 * @param {string}   docId  - String _id of the wallpaper document
 * @param {string[]} words  - normalized words extracted from the wallpaper
 * @param {object}   [opts]
 * @param {object}   [opts.Model]  - injectable SemanticNode model (for tests)
 */
async function linkWallpaperToGraph(docId, words, { Model = SemanticNode } = {}) {
  if (!docId || !words.length) return;
  const id = String(docId);
  // Upsert each word node and push the docId into its posting list (no duplicates).
  const ops = words.map((w) => ({
    updateOne: {
      filter: { word: w },
      update: {
        $addToSet: { docIds: id },
        $setOnInsert: { word: w },
      },
      upsert: true,
    },
  }));
  if (ops.length) await Model.bulkWrite(ops, { ordered: false });
  // Mirror in-memory.
  linkDocToWords(words, id);
}

/**
 * Called after Sharp/R2 upload. Returns the status the wallpaper must be saved with.
 * On AI failure: status 'draft' + AiIngestionJob so assets stay intact and hidden.
 * wallpaperId may be supplied via payload._id (create the job after save if absent;
 * see `queueDraftJob`).
 *
 * Always links the wallpaper to its words in the inverted index (even on AI failure)
 * so that direct document-ID search works immediately after upload.
 */
async function processWallpaperSemanticsOnUpload(payload, requestedStatus = 'published', deps = {}) {
  const words = extractCleanWords(payload);
  const wallpaperId = payload._id ? String(payload._id) : null;
  try {
    const res = await expandWords(words, deps);
    // Link the wallpaper's document ID to all its words in the inverted index.
    if (wallpaperId) await linkWallpaperToGraph(wallpaperId, words, deps);
    // If some words couldn't be expanded, queue a draft job to retry later
    if (res.missing && res.missing.length) {
      return { status: 'draft', unprocessedWords: res.missing, error: `Missing expansions for: ${res.missing.join(', ')}` };
    }
    return { status: requestedStatus, unprocessedWords: [], expanded: res.expanded };
  } catch (err) {
    let unseen = [];
    try { unseen = await findUnseenWords(words, deps.Model); } catch (_) { unseen = words; }
    // Still link the doc so it appears in ID-based results (semantic expansion will be partial).
    if (wallpaperId) {
      try { await linkWallpaperToGraph(wallpaperId, words, deps); } catch (_) { /* non-critical */ }
    }
    return { status: 'draft', unprocessedWords: unseen, error: err.message };
  }
}

async function queueDraftJob({ wallpaperId, desiredStatus, unprocessedWords, error }, Job = AiIngestionJob) {
  return Job.findOneAndUpdate(
    { wallpaperId },
    {
      $set: {
        desiredStatus: desiredStatus === 'scheduled' ? 'scheduled' : 'published',
        unprocessedWords,
        lastError: error || null,
        state: 'pending',
        nextRetryAt: new Date(),
      },
      $setOnInsert: { attempts: 0 },
    },
    { upsert: true, new: true }
  );
}

module.exports = {
  extractCleanWords,
  findUnseenWords,
  callLlmWithFallback,
  persistExpansionsToGraph,
  expandWords,
  linkWallpaperToGraph,
  processWallpaperSemanticsOnUpload,
  queueDraftJob,
  defaultProviders,
  sanitizeExpansions,
  buildPrompt,
};
