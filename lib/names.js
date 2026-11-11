// lib/names.js — player-name matching between sources (uploaded odds files vs history and ESPN names).
// Same rule as nflprob: lenient normalization first (case, punctuation, accents, spacing), and
// generational suffixes are stripped only as a fallback, never in the primary key — two real
// players can share a base name. The fallback is
// only accepted when it resolves to exactly one player in the field.

const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/g;

// Letters NFD doesn't decompose (ø is its own letter, not o + accent).
const TRANSLIT = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'ß': 'ss', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th', 'ð': 'd' };

function normName(name) {
  return String(name || '')
    .replace(/[øØæÆßłŁđĐþð]/g, ch => TRANSLIT[ch])
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Højgaard -> Hojgaard, Åberg -> Aberg
    .toLowerCase()
    .replace(/[.'’`,-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSuffix(norm) {
  return norm.replace(SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

// Books often list "Last, First" or "F. Last". Reorder "Last, First" before normalizing.
function canonicalOrder(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : s;
}

// A trailing qualifier picks between players who share a name: "Elias Pettersson (VAN)",
// "Sebastian Aho (D)", "Elias Pettersson - VAN D". Team abbreviations and positions (F, D, C, LW,
// RW, G) are accepted, in any order.
const QUAL_RE = /\s*(?:\(([^)]*)\)|\s-\s+([A-Za-z ]{1,12}))\s*$/;
function splitQualifier(raw) {
  const s = String(raw || '').trim(), m = s.match(QUAL_RE);
  if (!m) return { name: s, tokens: [] };
  return { name: s.slice(0, m.index).trim(), tokens: (m[1] || m[2] || '').toUpperCase().split(/[\s,/]+/).filter(Boolean) };
}
const posOf = p => { const x = String(p.pos || '').toUpperCase(); return x === 'D' ? 'D' : x === 'G' ? 'G' : x ? 'F' : null; };
const fits = (p, tokens) => tokens.every(t => (['F', 'C', 'LW', 'RW', 'W'].includes(t) ? posOf(p) === 'F' : ['D', 'G'].includes(t) ? posOf(p) === t : String(p.team || '').toUpperCase() === t));

const AMBIGUOUS = Object.freeze({ ambiguous: true });

// Build a matcher over the field once; returns name -> player, null (no match) or AMBIGUOUS (two or
// more players share the name and no qualifier separates them: the caller asks for one).
function buildMatcher(players) {
  const exact = new Map();
  const loose = new Map();
  const add = (m, k, p) => { const a = m.get(k); if (a) a.push(p); else m.set(k, [p]); };
  for (const p of players) {
    const n = normName(p.name);
    add(exact, n, p);
    add(loose, stripSuffix(n), p);
  }
  const choose = (cands, tokens) => {
    if (!cands?.length) return null;
    const pool = tokens.length ? cands.filter(p => fits(p, tokens)) : cands;
    return pool.length === 1 ? pool[0] : pool.length > 1 ? AMBIGUOUS : null;
  };
  return function match(rawName) {
    const { name, tokens } = splitQualifier(rawName);
    const n = normName(canonicalOrder(name));
    const e = choose(exact.get(n), tokens);
    if (e) return e;
    const hit = choose(loose.get(stripSuffix(n)), tokens);
    if (hit) return hit;
    // "A. Matthews" -> first initial + last name, accepted only when unique in the field.
    const parts = n.split(' ');
    if (parts.length >= 2 && parts[0].length === 1) {
      const last = parts.slice(1).join(' ');
      const cands = players.filter(p => {
        const pn = stripSuffix(normName(p.name)).split(' ');
        return pn[0][0] === parts[0] && pn.slice(1).join(' ') === stripSuffix(last);
      });
      const c = choose(cands, tokens);
      if (c) return c;
    }
    return null;
  };
}

module.exports = { normName, stripSuffix, buildMatcher, splitQualifier, AMBIGUOUS };
