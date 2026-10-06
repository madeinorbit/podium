/** Compact search facets belong to the source. No pool rows, subscriptions or
 * result cache are retained; only identities and the scalars that rank them. */
type Row = Readonly<Record<string, unknown>>
export interface IssueMentionQuestion {
  kind: 'issueMentionMatches'
  query: string
  limit: number
  prefixes: Readonly<Record<string, string | undefined>>
}
type Fact = { title: string; seq: number; repo: string; ref: string; at: number; order: number }
const grams = (text: string) => {
  const keys = new Set<string>()
  for (let width = 1; width <= Math.min(3, text.length); width++)
    for (let at = 0; at <= text.length - width; at++) keys.add(text.slice(at, at + width))
  return keys
}
const token = (text: string) => text.slice(0, Math.min(3, text.length))
const score = (ref: string, fact: Fact, q: string): number | undefined => {
  if (ref.startsWith(q)) return 100
  if (/^\d+$/.test(q) && String(fact.seq).startsWith(q)) return 90
  if (ref.includes(q)) return 70
  if (fact.title.startsWith(q)) return 60
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(fact.title)) return 50
  return fact.title.includes(q) ? 30 : undefined
}

export function createIssueMentionIndex() {
  const facts = new Map<string, Fact>(),
    postings = new Map<string, Set<string>>()
  const recent: string[] = [],
    repos = new Map<string, string[]>()
  let order = 0,
    revision = 0
  const counts = { visits: 0 }
  const bySequence = (a: string, b: string) =>
    facts.get(b)!.seq - facts.get(a)!.seq || facts.get(a)!.order - facts.get(b)!.order
  const byRecency = (a: string, b: string) =>
    facts.get(b)!.at - facts.get(a)!.at || facts.get(a)!.order - facts.get(b)!.order
  function insert(ids: string[], id: string, compare: (a: string, b: string) => number) {
    let lo = 0,
      hi = ids.length
    while (lo < hi) {
      const at = (lo + hi) >>> 1
      if (compare(ids[at]!, id) < 0) lo = at + 1
      else hi = at
    }
    ids.splice(lo, 0, id)
  }
  function remove(ids: string[], id: string, compare: (a: string, b: string) => number) {
    let lo = 0,
      hi = ids.length
    while (lo < hi) {
      const at = (lo + hi) >>> 1
      if (compare(ids[at]!, id) < 0) lo = at + 1
      else hi = at
    }
    if (ids[lo] === id) ids.splice(lo, 1)
  }
  // A native ref's numeric suffix is a sequence PREFIX, not a substring.
  // Search the existing per-repo sequence order as decimal ranges, then take
  // only its first ranked window; unrelated numeric grams never become candidates.
  function sequencePrefix(ids: readonly string[], digits: string, limit: number): string[] {
    const value = Number(digits)
    if (!Number.isSafeInteger(value) || String(value) !== digits || !ids.length) return []
    const max = facts.get(ids[0]!)!.seq
    const ranges: [number, number][] = []
    if (value === 0) ranges.push([0, 0])
    else
      for (let factor = 1; value * factor <= max; factor *= 10)
        ranges.push([value * factor, Math.min(max, (value + 1) * factor - 1)])
    const found: string[] = []
    for (const [lower, upper] of ranges.reverse()) {
      let lo = 0,
        hi = ids.length
      while (lo < hi) {
        const at = (lo + hi) >>> 1
        if (facts.get(ids[at]!)!.seq > upper) lo = at + 1
        else hi = at
      }
      for (let at = lo; at < ids.length && found.length < limit; at++) {
        const id = ids[at]!
        if (facts.get(id)!.seq < lower) break
        found.push(id)
      }
      if (found.length === limit) break
    }
    return found
  }
  const keys = (fact: Fact) => grams(`${fact.title}\n${fact.ref}\n${fact.seq}`)
  return {
    counts,
    get revision() {
      return revision
    },
    clear() {
      facts.clear()
      postings.clear()
      recent.length = 0
      repos.clear()
      order = 0
      revision++
    },
    set(id: string, row: Row | undefined) {
      const before = facts.get(id),
        date = Date.parse(String(row?.updatedAt ?? ''))
      const next: Fact | undefined =
        row && !row.archived && !row.deletedAt
          ? {
              title: String(row.title ?? '').toLowerCase(),
              seq: Number(row.seq ?? 0),
              repo: String(row.repoId ?? ''),
              ref: String(row.linearIdentifier ?? '')
                .trim()
                .toLowerCase(),
              at: Number.isNaN(date) ? 0 : date,
              order: before?.order ?? order++,
            }
          : undefined
      if (
        before?.title === next?.title &&
        before?.seq === next?.seq &&
        before?.repo === next?.repo &&
        before?.ref === next?.ref &&
        before?.at === next?.at
      )
        return
      // Title/ref posting updates need not move unchanged ordering positions.
      // Removing and reinserting either array shifts unrelated rows even when
      // its rank inputs stayed equal (for example a title-only publication).
      const recentMoved = before?.at !== next?.at
      const sequenceMoved = before?.seq !== next?.seq || before?.repo !== next?.repo ||
        Boolean(before && !before.ref) !== Boolean(next && !next.ref)
      if (before) {
        if (recentMoved) remove(recent, id, byRecency)
        if (!before.ref && sequenceMoved) {
          const ids = repos.get(before.repo)!
          remove(ids, id, bySequence)
          if (!ids.length) repos.delete(before.repo)
        }
        for (const key of keys(before)) {
          const ids = postings.get(key)!
          ids.delete(id)
          if (!ids.size) postings.delete(key)
        }
      }
      if (next) {
        facts.set(id, next)
        if (recentMoved) insert(recent, id, byRecency)
        if (!next.ref && sequenceMoved) {
          let ids = repos.get(next.repo)
          if (!ids) {
            ids = []
            repos.set(next.repo, ids)
          }
          insert(ids, id, bySequence)
        }
        for (const key of keys(next)) {
          let ids = postings.get(key)
          if (!ids) {
            ids = new Set()
            postings.set(key, ids)
          }
          ids.add(id)
        }
      } else facts.delete(id)
      revision++
    },
    ids(question: IssueMentionQuestion): string[] {
      const q = question.query.trim().toLowerCase(),
        limit = Math.max(0, Math.trunc(question.limit))
      if (!limit) return []
      if (!q) {
        const ids = recent.slice(0, limit)
        counts.visits += ids.length
        return ids
      }
      const candidates = new Set(postings.get(token(q)))
      const digits = q.match(/\d+$/)?.[0],
        refPart = digits ? q.slice(0, -digits.length) : undefined
      // Repository prefixes are small metadata. A prefix-only ref question has
      // identical rank within its repo, so only that repo's first window can win.
      for (const [repo, ids] of repos) {
        const prefix = question.prefixes[repo] ? `${question.prefixes[repo]}-`.toLowerCase() : '#'
        if (prefix.includes(q)) for (const id of ids.slice(0, limit)) candidates.add(id)
        else if (digits && refPart && prefix.endsWith(refPart))
          for (const id of sequencePrefix(ids, digits, limit)) candidates.add(id)
      }
      const winners: { id: string; score: number }[] = []
      for (const id of candidates) {
        counts.visits++
        const fact = facts.get(id)!
        const ref =
          fact.ref ||
          (question.prefixes[fact.repo]
            ? `${question.prefixes[fact.repo]}-${fact.seq}`.toLowerCase()
            : `#${fact.seq}`)
        const rank = score(ref, fact, q)
        if (rank === undefined) continue
        const entry = { id, score: rank }
        let at = 0
        while (
          at < winners.length &&
          (winners[at]!.score > rank ||
            (winners[at]!.score === rank && bySequence(winners[at]!.id, id) <= 0))
        )
          at++
        winners.splice(at, 0, entry)
        if (winners.length > limit) winners.pop()
      }
      return winners.map((row) => row.id)
    },
  }
}
