import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE FULL SESSION PROJECTION HAS THREE CALLERS, AND THIS COUNTS THEM
 * [POD-3857].
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT HAD TO
 * ---------------------------------------------------------------------------
 *
 * POD-2322's audit forbade three SPELLINGS — `listSessions().find(`,
 * `listSessions().some(`, and `sessionsForIssue(…listSessions())` — and kept an
 * allowlist of files permitted to use them. That was the right guard while the
 * projection was something every internal caller could reach and the problem
 * was reaching for it WASTEFULLY. It is the wrong guard now, in both
 * directions: the patterns it names can no longer be written at all (no
 * internal deps type exposes a full-list port, so the compiler refuses them
 * first), and it said nothing about the case that actually mattered — a caller
 * that takes the whole projection and uses all of it, wastefully, without a
 * `.find` in sight. Every one of the ~40 sites POD-3857 migrated was invisible
 * to it.
 *
 * So this counts CALL SITES rather than banning spellings. The set is meant to
 * be exhaustively enumerable, and an addition to it is meant to be a decision
 * somebody made on purpose and defended in review — which is what this failing
 * asks for.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SECOND GUARD, NOT THE FIRST
 * ---------------------------------------------------------------------------
 *
 * The primary guard is the type system: `listSessions` is absent from every
 * internal deps/ports type (steward, messages, messaging, issues, superagent,
 * worktree GC, teardown, revival, transfer, read-toolkit, session-access), and
 * {@link SessionListCaller} has no `unlabeled` member and no default, so a new
 * caller cannot compile without naming itself. A source scan cannot be talked
 * out of a verdict the way a reviewer can, which is why it is here too — but if
 * this test ever disagrees with the compiler, the compiler is right.
 */

const SRC = join(__dirname)

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })

/**
 * A call that BUILDS the reader-scoped projection for the whole fleet.
 *
 * `sessionView.list` and the `listSessions` facade over it. The narrow reads —
 * `listSessionsForIssue`, `sessionsById`, `sessionById` — are deliberately NOT
 * matched: they project a bounded set and are the supported way to get a wired
 * session.
 */
const FULL_LIST_CALL = /(?<![A-Za-z])(?:listSessions|view\.list|listSessionsForBootBaseline)\s*\(/

/**
 * WHO MAY BUILD IT, and why each one genuinely needs a reader-scoped wire
 * projection rather than {@link SessionFacts}.
 *
 * Adding a line here is adding a ~733 ms pass over the live corpus to some code
 * path. Say which path, and say what wire-only field forces it.
 *
 * `modules/sessions/view.ts` is deliberately NOT here. It DEFINES the pass
 * (`SessionView.list`) rather than calling it, so it matches neither the
 * offender scan nor the staleness check below — and listing it would grant the
 * definition site standing permission to grow a caller.
 */
const ALLOWED: Record<string, string> = {
  'modules/sessions/lifecycle.ts':
    'the service facade that forwards to it, labelled by its caller',
  'modules/sessions/session-wiring.ts':
    'composition: supplies the boot-baseline port with the bootstrap label',
  'modules/sessions/repository.ts':
    'boot ledger reconcile — this IS the client-visible baseline that sync.changesSince is served from',
  'modules/sessions/queries.ts':
    'the sessions.list RPC — a client reading its own session list',
  'modules/superagent/tools.ts':
    'the list_sessions agent tool — reports snooze state, which lives in the per-user overlay',
}

function offenders(source = SRC): string[] {
  const found: string[] = []
  for (const file of walk(source)) {
    const relative = file.slice(source.length + 1)
    if (relative in ALLOWED) continue
    // Comments discuss the projection constantly; only code counts.
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    if (FULL_LIST_CALL.test(text)) found.push(relative)
  }
  return found
}

describe('full session projection call sites [POD-3857]', () => {
  it('the scanner detects a planted full-list call', () => {
    expect(FULL_LIST_CALL.test('const all = await deps.listSessions(undefined, ' + "'rpc')")).toBe(
      true,
    )
    expect(FULL_LIST_CALL.test('await bag.view.list(undefined, ' + "'bootstrap')")).toBe(true)
  })

  it('does not mistake a narrow read for the full list', () => {
    expect(FULL_LIST_CALL.test('await deps.listSessionsForIssue(path, id)')).toBe(false)
    expect(FULL_LIST_CALL.test('await deps.sessionsById(ids)')).toBe(false)
    expect(FULL_LIST_CALL.test('await deps.sessionById(id)')).toBe(false)
    expect(FULL_LIST_CALL.test('this.deps.sessionFacts()')).toBe(false)
  })

  it('production builds the full projection only at the named surfaces', () => {
    expect(offenders()).toEqual([])
  })

  it('every allowlisted surface still makes the call it is allowlisted for', () => {
    for (const relative of Object.keys(ALLOWED)) {
      const text = readFileSync(join(SRC, relative), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      // An entry that has stopped calling it is stale permission — the next
      // caller to appear in that file would inherit it silently.
      expect(FULL_LIST_CALL.test(text), `${relative} no longer builds the full list`).toBe(true)
    }
  })
})
