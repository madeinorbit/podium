/**
 * Case-insensitive Jaro-Winkler + substring-containment "did you mean" ranking
 * [spec:SP-cc60]. Used to suggest the closest valid model/effort slug when a
 * spawn names one the live catalog doesn't have (e.g. a `claude-opus-4.8` typo
 * for `claude-opus-4-8`, or `highh` for `high`).
 *
 * Character-level, unlike the token-set `jaccard` in issue-similarity.ts: model
 * slugs are single dashed tokens where a one-character slip must still score high,
 * which word-overlap can't see.
 */

/** Jaro similarity of two strings, in [0, 1] (1 = identical). */
export function jaro(a: string, b: string): number {
  if (a === b) return 1
  const la = a.length
  const lb = b.length
  if (la === 0 || lb === 0) return 0
  // Two matching chars count only if no farther apart than this window.
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1)
  const aMatched = new Array<boolean>(la).fill(false)
  const bMatched = new Array<boolean>(lb).fill(false)
  let matches = 0
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window)
    const hi = Math.min(i + window + 1, lb)
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  // Half the number of matched chars that are out of order.
  let transpositions = 0
  let k = 0
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3
}

/** Jaro-Winkler similarity: Jaro boosted for a shared prefix (up to 4 chars),
 *  which favors slugs that agree from the start (`gpt-5.6` vs `gpt-5.6-sol`). */
export function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b)
  if (base === 0) return 0
  const maxPrefix = 4
  const scaling = 0.1
  let prefix = 0
  const cap = Math.min(maxPrefix, a.length, b.length)
  while (prefix < cap && a[prefix] === b[prefix]) prefix++
  return base + prefix * scaling * (1 - base)
}

/** Combined score used for ranking: case-insensitive Jaro-Winkler, with a floor of
 *  0.9 when either string contains the other so a clear substring match (e.g. the
 *  user typed a prefix of a real slug) always clears the suggestion threshold. */
export function similarityScore(query: string, candidate: string): number {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  const jw = jaroWinkler(q, c)
  const contained = q.length > 0 && c.length > 0 && (c.includes(q) || q.includes(c))
  return contained ? Math.max(jw, 0.9) : jw
}

export interface DidYouMeanOptions {
  /** Minimum combined score to be offered as a suggestion. */
  threshold?: number
  /** Maximum suggestions returned. */
  limit?: number
}

/**
 * The closest `candidates` to `query`, best first, scoring >= threshold. Ties keep
 * the candidates' original order (stable). Returns the candidates verbatim (original
 * case). Empty query or no candidate clearing the threshold yields [].
 */
export function didYouMean(
  query: string,
  candidates: readonly string[],
  { threshold = 0.85, limit = 3 }: DidYouMeanOptions = {},
): string[] {
  if (!query) return []
  return candidates
    .map((value, index) => ({ value, index, score: similarityScore(query, value) }))
    .filter((c) => c.score >= threshold)
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .slice(0, limit)
    .map((c) => c.value)
}
