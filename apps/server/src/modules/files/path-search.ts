/**
 * FUZZY PATH RANKING FOR THE COMPOSER @-MENU (POD-412).
 *
 * The composer completes `@src/comp` against the paths a checkout actually
 * tracks. Two decisions shape this file, and both are about WHERE the work
 * happens rather than how clever the scoring is:
 *
 * 1. THE LIST NEVER LEAVES THE SERVER. A `git ls-files` of this repository is
 *    ~180 KB and this is a keystroke-rate surface; shipping the tree to the
 *    browser once per session would trade one 180 KB transfer for a permanently
 *    larger client heap, and shipping it per query would be absurd. The daemon
 *    reads the index, the server ranks, and the wire carries at most `limit`
 *    rows — a few hundred bytes.
 *
 * 2. THE INDEX IS CACHED PER ROOT, BRIEFLY. Every keystroke past the debounce is
 *    a query, and each one would otherwise fork a git process on the session's
 *    machine. A 30-second TTL makes a burst of typing one `ls-files`; a file
 *    added mid-burst shows up a few seconds later, which is the correct trade
 *    for an autocomplete (and `--others` is deliberately NOT passed: untracked
 *    files would cost a full directory walk on every miss).
 *
 * The matcher itself is an ordinary subsequence scorer — the same shape every
 * editor's quick-open uses. It is pure and exported so it can be tested without
 * a daemon, a socket or a repository.
 */

/** One ranked path plus the score that ordered it (higher is better). */
export interface PathHit {
  readonly path: string
  readonly score: number
}

const isBoundary = (ch: string | undefined): boolean =>
  ch === undefined || ch === '/' || ch === '.' || ch === '-' || ch === '_'

/**
 * Score `needle` as an ACRONYM of `hay`: every character must either continue
 * the previous one or start a new word (after `/ . - _`). Null otherwise.
 *
 * This is the fallback for a query that is not simply contained in the path, and
 * the strictness is the point. An unrestricted subsequence matcher answers every
 * query with every long path — `atmention` "matches" a 90-character document
 * name by taking one letter here and one there — and a menu of six such rows,
 * ranked above nothing, is worse than an empty menu. Requiring word starts keeps
 * what people actually type (`acs` → `apps/chat/surface.ts`) and drops the rest.
 */
function scoreAcronym(hay: string, needle: string): number | null {
  let score = 0
  let from = 0
  let first = -1
  let prev = -1
  for (const ch of needle) {
    const at = hay.indexOf(ch, from)
    if (at === -1) return null
    if (at !== prev + 1 && !isBoundary(hay[at - 1])) return null
    if (first === -1) first = at
    if (at === prev + 1) score += 3
    else score += 5
    prev = at
    from = at + 1
  }
  // Filler walked through, capped so one long path is not punished endlessly.
  return score - Math.min(prev - first + 1 - needle.length, 40) / 2
}

/**
 * Score `path` against `query`, or null when the path is not a candidate.
 *
 * THE BASENAME IS ANSWERED FIRST, and that is the load-bearing part. Scoring
 * left-to-right across the whole path lets the directories eat the query — for
 * `chatcom`, the `c` of `src` and the `ch` of `chat` are consumed long before
 * the walk reaches `ChatComposer.tsx`, so the file the person obviously meant
 * scores like an accident.
 *
 * The tiers, in the order of how sure they are of what was meant:
 *
 *   1. the FILENAME contains the query — and starting with it is surer still;
 *   2. the PATH contains the query, which is what `modules/files/qu` is;
 *   3. the query is an ACRONYM of one or the other (see above).
 *
 * Shorter paths win ties (in `rankPaths`): with equal evidence the less specific
 * file is the more likely target, and it keeps the ordering stable rather than
 * incidental.
 */
export function scorePath(path: string, query: string): number | null {
  if (query === '') return 0
  const hay = path.toLowerCase()
  const needle = query.toLowerCase()
  const basename = hay.slice(hay.lastIndexOf('/') + 1)

  const inName = basename.indexOf(needle)
  if (inName !== -1) {
    const bonus = inName === 0 ? 20 : isBoundary(basename[inName - 1]) ? 10 : 0
    return 100 + bonus - Math.min(path.length, 60) / 12
  }
  const inPath = hay.indexOf(needle)
  if (inPath !== -1) {
    return 60 + (isBoundary(hay[inPath - 1]) ? 10 : 0) - Math.min(path.length, 60) / 12
  }
  const inNameAcronym = scoreAcronym(basename, needle)
  const acronym = Math.max(
    inNameAcronym === null ? -1 : inNameAcronym + 20,
    scoreAcronym(hay, needle) ?? -1,
  )
  if (acronym < 0) return null
  return acronym - Math.min(path.length, 60) / 12
}

/**
 * The best `limit` paths for `query`, best first. An empty query is not "no
 * filter and no order": it is the menu's opening frame, so it answers with the
 * shallowest paths — the ones a person recognises — rather than whatever the
 * index happened to list first.
 */
export function rankPaths(
  paths: readonly string[],
  query: string,
  limit: number,
): readonly PathHit[] {
  if (query === '') {
    return [...paths]
      .sort((a, b) => depth(a) - depth(b) || a.length - b.length || (a < b ? -1 : 1))
      .slice(0, limit)
      .map((path) => ({ path, score: 0 }))
  }
  const hits: PathHit[] = []
  for (const path of paths) {
    const score = scorePath(path, query)
    if (score !== null) hits.push({ path, score })
  }
  hits.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  )
  return hits.slice(0, limit)
}

const depth = (path: string): number => {
  let n = 0
  for (const ch of path) if (ch === '/') n++
  return n
}

/** `git ls-files -z` output → paths. NUL-separated, trailing NUL included. */
export function parseLsFiles(output: string): readonly string[] {
  return output.split('\0').filter((p) => p !== '')
}

/**
 * A per-root, TTL'd path index.
 *
 * Keyed by machine AND root because the same absolute path on two machines is
 * two different checkouts. A failed read is cached too, for a shorter window:
 * without that, a repository too large for the op (or a machine that is offline)
 * would fork a doomed git process on every keystroke.
 */
export class PathIndex {
  private readonly entries = new Map<string, { paths: readonly string[]; expiresAt: number }>()

  constructor(
    private readonly ttlMs = 30_000,
    private readonly failureTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The tracked paths under `key`, reading through `load` on a miss. The loader
   *  is passed per call rather than held: the daemon RPC it goes through belongs
   *  to the request's state, not to this cache. */
  async paths(
    key: { machineId?: string; root: string },
    load: () => Promise<{ ok: boolean; output: string }>,
  ): Promise<readonly string[]> {
    const cacheKey = `${key.machineId ?? ''}\0${key.root}`
    const cached = this.entries.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.paths
    const result = await load()
    const paths = result.ok ? parseLsFiles(result.output) : []
    this.entries.set(cacheKey, {
      paths,
      expiresAt: this.now() + (result.ok ? this.ttlMs : this.failureTtlMs),
    })
    return paths
  }
}
