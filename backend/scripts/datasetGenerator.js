const { addEdges, rebuildGraph } = require('../src/services/memoryGraph');

const BASE_WORDS = [
  'dragon', 'knight', 'warrior', 'mage', 'wizard', 'sorcerer', 'elf', 'dwarf', 'demon', 'angel',
  'samurai', 'ninja', 'titan', 'golem', 'valkyrie', 'phoenix', 'griffin', 'chimera', 'wolf', 'beast',
  'shadow', 'ghost', 'spirit', 'reaper', 'vampire', 'werewolf', 'siren', 'mermaid', 'fairy', 'pixie',
  'goblin', 'orc', 'ogre', 'troll', 'castle', 'fortress', 'citadel', 'dungeon', 'ruins', 'shrine',
  'temple', 'cathedral', 'tower', 'palace', 'forest', 'mountain', 'valley', 'canyon', 'cavern', 'desert',
  'tundra', 'glacier', 'ocean', 'archipelago', 'abyss', 'celestial', 'horizon', 'void', 'cyberpunk', 'neon',
  'metropolis', 'alleyway', 'garden', 'waterfall', 'sanctuary', 'observatory', 'steampunk', 'blade', 'katana', 'sword',
  'shield', 'armor', 'bow', 'staff', 'scythe', 'rune', 'grimoire', 'portal', 'eclipse', 'aurora',
  'nebula', 'supernova', 'lightning', 'flame', 'blizzard', 'vortex', 'relic', 'artifact', 'crystal', 'gem',
  'orb', 'talisman', 'sigil', 'mech', 'android', 'cyber', 'hacker', 'spaceship', 'planet', 'galaxy',
  'star', 'moon', 'sun', 'sky', 'clouds', 'rain', 'sunset', 'sunrise', 'dusk', 'dawn',
  'twilight', 'midnight', 'sakura', 'lotus', 'cherry', 'blossom', 'rose', 'lily', 'orchid', 'willow',
  'pine', 'oak', 'ember', 'spark', 'ash', 'smoke', 'frost', 'ice', 'mist', 'fog',
  'haze', 'storm', 'tempest', 'thunder', 'dark', 'light', 'crimson', 'azure', 'emerald', 'golden'
];

const PREFIXES = [
  'star', 'moon', 'sun', 'sky', 'sea', 'fire', 'ice', 'blood', 'storm', 'soul',
  'dream', 'night', 'dawn', 'dusk', 'iron', 'shadow', 'neo', 'hyper', 'cyber', 'chrono',
  'necro', 'bio', 'dark', 'light', 'void', 'astro', 'aqua', 'pyro', 'aero', 'geo',
  'electro', 'cryo', 'psycho', 'techno', 'retro', 'proto', 'omni', 'ultra', 'mega', 'micro',
  'meta', 'holo', 'nano', 'quantum', 'solar', 'lunar', 'stellar', 'astral', 'nether', 'ether',
  'abyssal', 'primal', 'ancient', 'golden', 'silver', 'crystal', 'emerald', 'ruby', 'sapphire', 'diamond',
  'onyx', 'obsidian', 'mystic', 'arcane', 'divine', 'infernal', 'phantom', 'spectral', 'radiant', 'cosmic',
  'twilight', 'midnight', 'tempest', 'thunder', 'lightning', 'frost', 'blizzard', 'vortex', 'chaos', 'order',
  'infinity', 'zenith', 'apex', 'titan', 'dragon', 'angel', 'demon', 'knight', 'blade', 'ghost',
  'spirit', 'echo', 'mirage', 'aurora', 'eclipse', 'nebula', 'rift', 'haven', 'crest', 'spire'
];

const SUFFIXES = [
  'blade', 'wing', 'heart', 'soul', 'strike', 'fall', 'rise', 'song', 'light', 'bane',
  'guard', 'watcher', 'keeper', 'weaver', 'breaker', 'stalker', 'hunter', 'seeker', 'caller', 'walker',
  'rider', 'runner', 'slayer', 'bringer', 'born', 'fire', 'frost', 'storm', 'shade', 'mist',
  'flare', 'glow', 'gleam', 'burst', 'shard', 'spark', 'dust', 'haze', 'bloom', 'drift',
  'path', 'trail', 'forge', 'vault', 'gate', 'peak', 'spire', 'crest', 'vale', 'woods',
  'deep', 'tide', 'rift', 'haven', 'reach', 'ward', 'hold', 'mark', 'crown', 'gaze',
  'roar', 'cry', 'leap', 'bond', 'fang', 'claw', 'edge', 'horn', 'scale', 'helm',
  'rune', 'stone', 'star', 'moon', 'sun', 'void', 'wind', 'ash', 'root', 'thorn',
  'leaf', 'branch', 'wave', 'surge', 'pulse', 'flash', 'beam', 'flux', 'core', 'node',
  'sphere', 'nexus', 'drop', 'tear', 'seed', 'shroud', 'veil', 'mantle', 'aura', 'echo'
];

const RELATIONS = ['synonym', 'hyponym', 'hypernym', 'sibling', 'scene', 'mood', 'tangent'];

function generate10kWords() {
  const wordSet = new Set();
  for (const w of BASE_WORDS) {
    if (wordSet.size >= 10000) break;
    wordSet.add(w);
  }
  for (const p of PREFIXES) {
    for (const s of SUFFIXES) {
      if (wordSet.size >= 10000) break;
      const combined = `${p}${s}`;
      if (combined.length >= 3 && combined.length <= 30) {
        wordSet.add(combined);
      }
    }
    if (wordSet.size >= 10000) break;
  }
  let extraIndex = 0;
  while (wordSet.size < 10000) {
    wordSet.add(`term${extraIndex++}`);
  }
  return Array.from(wordSet).slice(0, 10000);
}

function generate10kNodes(words) {
  const nodes = [];
  const N = words.length;
  // Deterministic pseudo-random using Mulberry32
  let seed = 1337420;
  function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  for (let i = 0; i < N; i++) {
    const word = words[i];
    // Hubs (first 100 words): 25-40 edges
    // Mid-tier (next 1500 words): 8-15 edges
    // Rest: 3-6 edges
    let edgeCount;
    if (i < 100) {
      edgeCount = 25 + Math.floor(random() * 16);
    } else if (i < 1600) {
      edgeCount = 8 + Math.floor(random() * 8);
    } else {
      edgeCount = 3 + Math.floor(random() * 4);
    }

    const seenTargets = new Set([word]);
    const edges = [];
    for (let e = 0; e < edgeCount; e++) {
      // 40% bias toward hub nodes for realistic scale-free network topology
      let targetIdx;
      if (random() < 0.4) {
        targetIdx = Math.floor(random() * 100);
      } else {
        targetIdx = Math.floor(random() * N);
      }
      const target = words[targetIdx];
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);

      const relation = RELATIONS[Math.floor(random() * RELATIONS.length)];
      const weight = 1 + Math.floor(random() * 6);
      edges.push({ target, weight, relation });
    }
    nodes.push({ word, edges });
  }
  return nodes;
}

function buildPopulatedGraph(nodes) {
  const graph = new Map();
  rebuildGraph(graph, nodes);
  return graph;
}

module.exports = {
  generate10kWords,
  generate10kNodes,
  buildPopulatedGraph,
  BASE_WORDS,
  PREFIXES,
  SUFFIXES,
  RELATIONS,
};
