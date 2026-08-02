import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// POD-330 — F3's SHAPE CLAUSE, the sibling of session-status.shape-clause.
//
// F3's invariant, like F1's, has two clauses, and only one of them is a thing a
// test can hold:
//
//   SHAPE (checkable, and checked here): a collection of sessions in, an order
//     or a rank out. No issues, no rows, no repos. No slice imports.
//   QUESTION (not checkable, and NOT checked here): what order sessions are
//     presented in — whether decided by COMPARING them (sortSessionsForSidebar,
//     sessionUrgencyRank, mostUrgentSession) or by HONOURING AN EXTERNAL
//     DESIGNATION (elevateCoordinatorSession, whose key is an id handed in).
//
// THIS FILE EXISTS BECAUSE THE SHAPE CLAUSE ALREADY ADMITTED A SYMBOL ITS
// QUESTION CLAUSE HAD NOT CONSIDERED. POD-1503 moved `elevateCoordinatorSession`
// here to delete the `worklist -> terminal` edge, and argued it against F3's
// invariant verbatim — correctly, on the shape. The function next to it,
// `isCoordinatorSession`, was refused on sight because it takes an `IssueWire`.
// Two adjacent symbols, one claimed and one refused, arbitrated by the SHAPE
// while the question was never consulted. Map §4e.1.
//
// So this test is named for the half it enforces. It would have refused
// `isCoordinatorSession` and it would NOT have refused
// `elevateCoordinatorSession` — which is the point, stated up front rather than
// discovered by whoever trusts it next.
//
// A SHAPE PREDICATE IS A NECESSARY CONDITION, NOT A SUFFICIENT ONE.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(new URL('./session-urgency.ts', import.meta.url), 'utf8')

function exportedSignatures(source: string): { name: string; params: string }[] {
  const out: { name: string; params: string }[] = []
  const re = /^export function (\w+)\(([\s\S]*?)\)(?::|\s*\{)/gm
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1] as string, params: m[2] as string })
  }
  return out
}

describe('F3 session-urgency: the SHAPE clause (the checkable half of the invariant)', () => {
  it('finds the exported functions at all (the check can fire)', () => {
    // A source scanner that matches nothing passes every assertion it makes.
    const sigs = exportedSignatures(SOURCE)
    expect(sigs.length).toBeGreaterThanOrEqual(4)
    expect(sigs.map((s) => s.name)).toContain('sortSessionsForSidebar')
  })

  it('no exported function takes an issue, a row or a repo', () => {
    const offenders = exportedSignatures(SOURCE).filter(({ params }) =>
      /\bIssue\w*|\bUnified\w*Row\b|\bRepo\w*View\b|\bGitRepositoryWire\b/.test(params),
    )
    // This clause is what refused `isCoordinatorSession` when the coordinator
    // family was split between here and the terminal slice.
    expect(offenders.map((o) => o.name)).toEqual([])
  })

  it('imports only the model and focus, so it cannot participate in a cycle', () => {
    const froms = (SOURCE.match(/^import[\s\S]*?from '([^']+)'/gm) ?? []).map(
      (line) => (line.match(/from '([^']+)'$/) as string[])[1] as string,
    )
    expect(froms.length).toBeGreaterThan(0)
    expect([...froms].sort()).toEqual(['../focus', '@podium/model'])
  })

  it('every export is about sessions — the collection question, not membership or presentation', () => {
    // F1 holds one-session presentation and F2 holds membership; a symbol here
    // that took neither a session nor a collection of them would belong to one
    // of those instead.
    for (const { name, params } of exportedSignatures(SOURCE)) {
      expect(`${name}:${params}`).toMatch(/SessionMeta/)
    }
  })
})
