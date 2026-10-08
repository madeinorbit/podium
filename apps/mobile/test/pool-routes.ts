import { referenceView } from '@podium/client-graph/issue-reference'
/** Fully resident synthetic address fixtures; route and chip outputs come from the production pool. */
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { PodiumTarget } from '@podium/protocol'
import { parseAnyRef, parseSessionRef } from '@podium/protocol'

interface AddressIssue {
  id: string
  seq?: number
  prefix?: string
  displayRef?: string
  title?: string
  stage?: string
}
interface AddressSession {
  sessionId: string
  displayRef?: string
  refRepoId?: string
  refSeq?: number
  refLetter?: string
  refDraft?: number
}
export function poolRouteFixture(input: {
  issues: readonly AddressIssue[]
  sessions: readonly AddressSession[]
}) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  // Historical route fixtures sometimes supplied displayRef alone. Feed
  // their normalized identity through the same repo composition as production.
  const issues = input.issues.map(row => {
    const ref = parseAnyRef(row.displayRef ?? '')
    return { ...row, seq: row.seq ?? (ref?.kind === 'issue' ? ref.seq : 0),
      prefix: row.prefix ?? (ref?.kind === 'issue' ? ref.prefix : undefined) }
  })
  // Sessions need the same normalized identity: the indexed sessionReference
  // question keys on (refRepoId, refSeq/refLetter or refDraft), resolved
  // through the prefix→repo composition. Preserve caller-supplied normalized
  // fields (the corpus `after` rows carry real refRepoIds); derive synthetic
  // ones from displayRef when only the human ref is given.
  const sessions: AddressSession[] = input.sessions.map(row => {
    if (
      row.refRepoId !== undefined ||
      row.refSeq !== undefined ||
      row.refLetter !== undefined ||
      row.refDraft !== undefined
    ) {
      return { ...row }
    }
    const ref = parseSessionRef(row.displayRef ?? '')
    if (!ref) return { sessionId: row.sessionId, displayRef: row.displayRef }
    if (ref.draft !== undefined) {
      return { sessionId: row.sessionId, displayRef: row.displayRef, refRepoId: ref.prefix, refDraft: ref.draft }
    }
    return {
      sessionId: row.sessionId,
      displayRef: row.displayRef,
      refRepoId: ref.prefix,
      refSeq: ref.seq,
      refLetter: ref.letter,
    }
  })
  // Worktree composition for both entity kinds: issues use the synthetic
  // prefix-as-repoId mapping; sessions may carry real refRepoIds (corpus
  // `after` rows), so file each distinct (prefix, repoId) pair they need.
  const worktreeRows: { kind: 'worktree'; id: string; value: never }[] = [
    ...[...new Set(issues.flatMap((row) => (row.prefix ? [row.prefix] : [])))].map((prefix) => ({
      kind: 'worktree' as const,
      id: `/synthetic/${prefix}`,
      value: {
        path: `/synthetic/${prefix}`,
        repoId: prefix,
        prefix,
        repoPath: `/synthetic/${prefix}`,
        repoName: prefix,
      } as never,
    })),
  ]
  const seenPairs = new Set(issues.flatMap((row) => (row.prefix ? [`${row.prefix}\0${row.prefix}`] : [])))
  for (const row of sessions) {
    const parsed = parseSessionRef(row.displayRef ?? '')
    const prefix = parsed?.prefix
    if (!prefix || !row.refRepoId) continue
    // Only file the real composition; the synthetic prefix→prefix row above
    // already covers displayRef-only sessions.
    if (row.refRepoId === prefix) continue
    const key = `${prefix}\0${row.refRepoId}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    worktreeRows.push({
      kind: 'worktree' as const,
      id: `/synthetic/${prefix}/${row.refRepoId}`,
      value: {
        path: `/synthetic/${prefix}/${row.refRepoId}`,
        repoId: row.refRepoId,
        prefix,
        repoPath: `/synthetic/${prefix}/${row.refRepoId}`,
        repoName: prefix,
      } as never,
    })
  }
  // Sessions without a caller-supplied prefix still need their synthetic
  // prefix row when issues did not already file it.
  for (const row of sessions) {
    const parsed = parseSessionRef(row.displayRef ?? '')
    const prefix = parsed?.prefix
    if (!prefix) continue
    const key = `${prefix}\0${prefix}`
    if (seenPairs.has(key)) continue
    // A real (prefix, refRepoId) row already covers this prefix's repo
    // composition; the synthetic row would be a second holder for the same
    // prefix, which is harmless but unnecessary when the real one exists.
    const hasReal = [...seenPairs].some((k) => k.startsWith(`${prefix}\0`))
    if (hasReal) continue
    seenPairs.add(key)
    worktreeRows.push({
      kind: 'worktree' as const,
      id: `/synthetic/${prefix}`,
      value: {
        path: `/synthetic/${prefix}`,
        repoId: prefix,
        prefix,
        repoPath: `/synthetic/${prefix}`,
        repoName: prefix,
      } as never,
    })
  }
  pool.apply({
    type: 'replace',
    rows: [
      ...worktreeRows,
      ...issues.map((row) => ({
        kind: 'issue' as const,
        id: row.id,
        value: {
          title: row.id,
          stage: 'backlog',
          archived: false,
          deps: [],
          repoPath: '/synthetic',
          createdAt: '',
          updatedAt: '',
          ...row,
          repoId: row.prefix,
        } as never,
      })),
      ...sessions.map((row) => ({
        kind: 'session' as const,
        id: row.sessionId,
        // Address identity only, but with normalized ref keys: resume-chain
        // membership still belongs to a separate reader question, so strip
        // anything else a full SessionView may carry.
        value: {
          sessionId: row.sessionId,
          displayRef: row.displayRef,
          ...(row.refRepoId !== undefined ? { refRepoId: row.refRepoId } : {}),
          ...(row.refSeq !== undefined ? { refSeq: row.refSeq } : {}),
          ...(row.refLetter !== undefined ? { refLetter: row.refLetter } : {}),
          ...(row.refDraft !== undefined ? { refDraft: row.refDraft } : {}),
        } as never,
      })),
    ],
  })
  pool.sources.register(['mobileInboxState'], {
    read: () => ({ hasCursor: true }),
    dispose() {},
  })
  const views = createMobileInboxViews(pool)
  return {
    pool,
    views,
    route(target: PodiumTarget): string | null {
      let route = views.route(target)
      if (route === LOADING && target.kind === 'issue') {
        // This fixture declares that every visible row is resident. A missing
        // identity query therefore has an authoritative empty answer.
        referenceView(pool).resolved(target.issue, null)
        route = views.route(target)
      }
      if (route === LOADING) throw new Error('Resident address fixture unexpectedly cold')
      return route ?? null
    },
    dispose() {
      views.dispose()
      pool.dispose()
    },
  }
}
export function poolRoute(target: PodiumTarget, input: Parameters<typeof poolRouteFixture>[0]) {
  const fixture = poolRouteFixture(input)
  try {
    return fixture.route(target)
  } finally {
    fixture.dispose()
  }
}
