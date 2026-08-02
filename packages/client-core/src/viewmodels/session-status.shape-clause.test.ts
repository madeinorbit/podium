import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// POD-330 — F1's SHAPE CLAUSE. Half of an invariant, and the half that a test
// can actually hold.
//
// session-status.ts is over the acceptance criterion's ~400 lines. It is not
// split, because it answers exactly ONE question — what one session is doing —
// and a module cut by line count rather than by question is the failure this
// issue already had once: the first attempt produced `worklist-helpers.ts` (38
// lines) and `nav-types.ts` (37), two shared-helper bags whose own filenames
// were the diagnosis.
//
// An exception is only worth anything if the property it claims is CHECKED, so
// this file checks it. The claim is the module's stated membership invariant:
//
//   one session in — optionally with its own issue — one presentation value out.
//   No collections, no cross-entity state, no ordering, no lists.
//
// WHAT THIS FILE CHECKS, AND WHAT IT CANNOT. The invariant has two clauses:
//
//   SHAPE (checkable, and checked here): one session in — optionally with its
//     issue — one presentation value out. No collections. No slice imports.
//   QUESTION (not checkable, and NOT checked anywhere): "what one session is
//     doing". A presentation value about one session, not about the world.
//
// The file is named for the half it enforces, because the other half is exactly
// where the drift that produces god objects arrives: nobody ever adds a symbol
// whose SHAPE looks wrong. POD-1503 demonstrated it on F3 an hour after this
// test landed — `elevateCoordinatorSession` satisfied F3's shape clause
// verbatim while answering a question F3 does not ask (it honours an external
// designation rather than comparing sessions), and the shape clause admitted it
// without the question clause ever being consulted. See map §4e.1.
//
// A SHAPE PREDICATE IS A NECESSARY CONDITION, NOT A SUFFICIENT ONE. Treating
// this file as full enforcement of F1's invariant is the mistake it is named to
// prevent.
//
// The day this predicate fails is still the day the size exception expires: a
// collection parameter here means the one question became two.
//
// Deliberately source-level rather than behavioural: the invariant is about what
// the module is ALLOWED to be handed, which no runtime call can observe.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(new URL('./session-status.ts', import.meta.url), 'utf8')

/** `export function name(` … up to the closing paren of the parameter list. */
function exportedSignatures(source: string): { name: string; params: string }[] {
  const out: { name: string; params: string }[] = []
  const re = /^export function (\w+)\(([\s\S]*?)\)(?::|\s*\{)/gm
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1] as string, params: m[2] as string })
  }
  return out
}

describe('F1 session-status: the SHAPE clause (the checkable half of the invariant)', () => {
  it('finds the exported functions at all (the check can fire)', () => {
    const sigs = exportedSignatures(SOURCE)
    // A parser that matched nothing would pass every assertion below. Name the
    // count so a refactor that changes the declaration style fails HERE, loudly,
    // rather than turning this file into a green no-op.
    expect(sigs.length).toBeGreaterThanOrEqual(15)
    expect(sigs.map((s) => s.name)).toContain('agentBadge')
  })

  it('no exported function takes a COLLECTION of sessions', () => {
    const offenders = exportedSignatures(SOURCE).filter(({ params }) =>
      /SessionMeta\s*\[\]|readonly\s+SessionMeta\[\]|Array<\s*SessionMeta\s*>|Iterable<\s*SessionMeta/.test(
        params,
      ),
    )
    // Ranking, grouping and filtering sessions are F3 and the slices' questions.
    // A collection parameter here is the module becoming a bag.
    expect(offenders.map((o) => o.name)).toEqual([])
  })

  it('imports no slice, so it cannot participate in a cycle', () => {
    const imports = SOURCE.match(/^import[\s\S]*?from '([^']+)'/gm) ?? []
    const froms = imports.map((line) => (line.match(/from '([^']+)'$/) as string[])[1] as string)
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) {
      expect(from).not.toMatch(/slices\//)
      expect(from).not.toMatch(/\.\/(session-urgency|session-ownership)/)
    }
  })

  it('the size exception this clause supports is still in force', () => {
    // If the module ever needs a second exception, that is the signal that the
    // one question has become two — which is a reason to split, not to widen.
    const lines = SOURCE.split('\n').length
    expect(lines).toBeGreaterThan(400)
    expect(lines).toBeLessThan(600)
  })
})
