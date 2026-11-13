// Exact Jaccard threshold join. Prefix filtering avoids comparing every pair;
// it does not sample or truncate symbols. Both prefixes use one global ordering.
// The visitor form lets aggregate-only callers avoid materializing every pair.
export function forEachSimilarShinglePair(items, threshold = 0.85, includePair = () => true, visit) {
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError("similarity threshold must be in (0, 1]");
  if (typeof visit !== "function") throw new TypeError("visit must be a function");
  const frequencies = new Map();
  for (const item of items) for (const token of item.shingles) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  const ordered = items.map((item, index) => ({ item, index })).sort((a, b) => a.item.shingles.size - b.item.shingles.size);
  const postings = new Map();
  for (const { item, index } of ordered) {
    const size = item.shingles.size;
    if (!size) continue;
    const prefixSize = size - Math.ceil(threshold * size - 1e-10) + 1;
    const prefix = [...item.shingles].sort((a, b) => frequencies.get(a) - frequencies.get(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, prefixSize);
    const candidates = new Set();
    for (const token of prefix) {
      for (const candidate of postings.get(token) || []) {
        if (items[candidate].shingles.size >= threshold * size - 1e-10) candidates.add(candidate);
      }
    }
    for (const candidate of candidates) {
      const left = Math.min(candidate, index), right = Math.max(candidate, index);
      if (!includePair(items[left], items[right])) continue;
      const a = items[candidate].shingles, b = item.shingles;
      const required = Math.ceil(threshold * (a.size + b.size) / (1 + threshold) - 1e-10);
      let intersection = 0, remaining = a.size;
      for (const token of a) {
        if (b.has(token)) intersection++;
        remaining--;
        if (intersection + remaining < required) break;
      }
      const similarity = intersection / (a.size + b.size - intersection);
      if (similarity >= threshold) visit(left, right, similarity);
    }
    for (const token of prefix) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push(index);
    }
  }
}

export function findSimilarShinglePairs(items, threshold = 0.85, includePair = () => true) {
  const pairs = [];
  forEachSimilarShinglePair(items, threshold, includePair, (left, right, similarity) => {
    pairs.push({ left, right, similarity });
  });
  return pairs.sort((a, b) => a.left - b.left || a.right - b.right);
}
