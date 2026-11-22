// Single-elimination bracket as a plain JSON object: { order: string[], picks: [{matchId, winnerId}] }.
// All state is derived by replaying picks over the shuffled order, so every function is pure.

export class MatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatchError';
  }
}

export function createBracket(ids, rng) {
  if (new Set(ids).size !== ids.length) throw new MatchError('duplicate ids');
  const order = ids.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { order, picks: [] };
}

function roundLabel(size) {
  if (size === 2) return '결승';
  if (size === 4) return '준결승';
  return `${size}강`;
}

// Replay picks. Returns { current, ranks, complete }.
function derive(b) {
  const n = b.order.length;
  const total = n < 2 ? 0 : n - 1 + (n >= 4 ? 1 : 0);
  if (n === 0) return { current: null, ranks: [], complete: true };
  if (n === 1) return { current: null, ranks: [b.order[0]], complete: true };

  const winners = new Map(b.picks.map((p) => [p.matchId, p.winnerId]));
  const ask = (id, a, bb, label) => {
    const w = winners.get(id);
    if (w === undefined) {
      return { stop: { id, a, b: bb, label, index: b.picks.length + 1, total } };
    }
    return { winner: w, loser: w === a ? bb : a };
  };

  let size = 1;
  while (size < n) size *= 2;
  const byes = size - n;
  // Byes occupy the top pairs; the real id advances automatically.
  let entrants = [];
  let k = 0;
  for (let i = 0; i < size / 2; i++) {
    if (i < byes) entrants.push(b.order[k++], null);
    else entrants.push(b.order[k++], b.order[k++]);
  }

  let round = 1;
  let semiLosers = [];
  while (entrants.length > 1) {
    const isFinal = entrants.length === 2;
    const next = [];
    const losers = [];
    for (let i = 0; i < entrants.length; i += 2) {
      const x = entrants[i], y = entrants[i + 1];
      if (y === null) { next.push(x); continue; }
      const id = isFinal ? 'final' : `r${round}m${i / 2}`;
      const r = ask(id, x, y, roundLabel(entrants.length));
      if (r.stop) return { current: r.stop, ranks: [], complete: false };
      next.push(r.winner);
      losers.push(r.loser);
    }
    if (entrants.length === 4) {
      semiLosers = losers;
      if (losers.length === 2) {
        const r = ask('third', losers[0], losers[1], '3·4위전');
        if (r.stop) return { current: r.stop, ranks: [], complete: false };
        semiLosers = [r.winner];
      }
    }
    if (isFinal) {
      const out = [next[0], losers[0]];
      if (semiLosers.length) out.push(semiLosers[0]);
      return { current: null, ranks: out, complete: true };
    }
    entrants = next;
    round++;
  }
  return { current: null, ranks: [], complete: true };
}

export function currentMatch(b) {
  return derive(b).current;
}

export function applyPick(b, matchId, winnerId) {
  const m = currentMatch(b);
  if (!m || m.id !== matchId) throw new MatchError(`match not open: ${matchId}`);
  if (winnerId !== m.a && winnerId !== m.b) throw new MatchError(`invalid winner: ${winnerId}`);
  return { order: b.order.slice(), picks: [...b.picks, { matchId, winnerId }] };
}

export function undo(b) {
  if (!b.picks.length) return b;
  return { order: b.order.slice(), picks: b.picks.slice(0, -1) };
}

export function ranks(b) {
  return derive(b).ranks;
}

export function merge(ranksA, ranksB, scores) {
  const posB = new Map(ranksB.map((id, i) => [id, i + 1]));
  const common = ranksA
    .map((id, i) => ({ id, sum: i + 1 + (posB.get(id) ?? 0), both: posB.has(id) }))
    .filter((x) => x.both);
  if (!common.length) return { jointFinal: [ranksA[0], ranksB[0]] };
  common.sort((p, q) => p.sum - q.sum || (scores[q.id] ?? 0) - (scores[p.id] ?? 0));
  const saved = common.map((x) => x.id);
  if (ranksA[0] === ranksB[0]) {
    saved.splice(saved.indexOf(ranksA[0]), 1);
    saved.unshift(ranksA[0]);
  }
  return { saved };
}
