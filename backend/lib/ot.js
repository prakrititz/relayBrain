/**
 * Ordered patch apply. Same-file overlapping hunks → manual merge (no busy-wait).
 */
function parseHunks(diff) {
  const hunks = [];
  let line = 0;
  for (const raw of String(diff || "").split("\n")) {
    const header = raw.match(/^@@ -(\d+)/);
    if (header) {
      line = Number(header[1]);
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ")) {
      hunks.push({ line, kind: raw[0], text: raw.slice(1) });
      if (raw[0] !== "+") line += 1;
    }
  }
  return hunks;
}

function overlaps(a, b) {
  const ha = parseHunks(a.diff);
  const hb = parseHunks(b.diff);
  if (!ha.length || !hb.length) return false;
  const range = (hunks) => {
    const lines = hunks.map((h) => h.line);
    return [Math.min(...lines), Math.max(...lines)];
  };
  const [a0, a1] = range(ha);
  const [b0, b1] = range(hb);
  return a0 <= b1 && b0 <= a1;
}

function transformPair(first, second) {
  if (first.file !== second.file) return { ok: true, patches: [first, second] };
  if (first.sha256 && second.sha256 && first.binary) {
    return first.lamport <= second.lamport
      ? { ok: true, patches: [first, second] }
      : { ok: true, patches: [second, first] };
  }
  if (overlaps(first, second)) {
    return {
      ok: false,
      manual: true,
      reason: `Conflicting patches on ${first.file} (Lamport ${first.lamport} vs ${second.lamport})`,
    };
  }
  const ordered = first.lamport <= second.lamport ? [first, second] : [second, first];
  return { ok: true, patches: ordered };
}

function insertOrdered(buffer, patch) {
  const next = [...buffer, patch].sort((a, b) => a.lamport - b.lamport || a.file.localeCompare(b.file));
  return next;
}

function drain(buffer, lastApplied) {
  const ready = [];
  const held = [];
  let applied = lastApplied || 0;
  const sorted = [...buffer].sort((a, b) => a.lamport - b.lamport);
  for (const p of sorted) {
    if (p.lamport <= applied) continue;
    if (applied === 0 || p.lamport === applied + 1) {
      ready.push(p);
      applied = p.lamport;
    } else {
      held.push(p);
    }
  }
  return { ready, held, lastApplied: applied };
}

module.exports = { parseHunks, overlaps, transformPair, insertOrdered, drain };
