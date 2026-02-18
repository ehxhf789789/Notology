/**
 * Compute the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use two rows for space optimization
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  let curr = new Array(lb + 1);

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

/**
 * Find tags similar to the query, sorted by distance.
 * Skips exact matches (distance 0).
 */
export function findSimilarTags(
  query: string,
  candidates: string[],
  maxDistance: number = 2,
): Array<{ tag: string; distance: number }> {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: Array<{ tag: string; distance: number }> = [];

  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    const dist = levenshteinDistance(q, c);
    if (dist > 0 && dist <= maxDistance) {
      results.push({ tag: candidate, distance: dist });
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, 5);
}
