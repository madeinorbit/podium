import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const harness = readFileSync(join(root, 'scripts/docker-update-e2e.sh'), 'utf8')

/**
 * THE MATRIX HAS TO SAY WHICH OF THREE THINGS HAPPENED (POD-2813).
 *
 * A row with no result used to print one fixed sentence — "not reached after an
 * earlier failure" — no matter why it was blank. So a clean
 * `PODIUM_UPDATE_E2E_ONLY=real-release` run, where every substantive row passed
 * and `environment` simply is not in that lane, printed the SAME words as a run
 * that was killed halfway through. The coordinator who found this had to read the
 * process table to tell which one they were looking at.
 *
 * These tests drive the real script's own functions — `matrix`, `skip_reason`,
 * `scope_out_remaining`, `unexplained_rows`, and the real per-lane `SCENARIOS`
 * arrays — by sourcing it, which the harness supports (its `main` runs only when
 * the file is executed). Nothing here starts Docker; what is being pinned is the
 * REPORTING, which is where the defect was.
 *
 * The load-bearing assertion is the last one in each group: the three sentences
 * must not be substrings of one another, because "you cannot tell them apart" was
 * the bug, not the wording.
 */

/** Source the harness under a lane and run bash against its own functions. */
function drive(only: string, script: string): string {
  return execFileSync('bash', ['-c', `source scripts/docker-update-e2e.sh\n${script}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PODIUM_UPDATE_E2E_ONLY: only },
  })
}

/** The evidence cell the matrix printed for one row. */
function evidenceFor(matrix: string, row: string): string {
  const line = matrix.split('\n').find((l) => l.startsWith(`${row} `) || l.startsWith(`${row}|`))
  if (!line) throw new Error(`row ${row} is not in the matrix:\n${matrix}`)
  return line.split('|').slice(2).join('|').trim()
}

const laneGreen = [
  'resource-safety',
  'coordinator-install',
  'advertised-url',
  'real-release-install',
  'real-release-pairing-refusal',
  'real-release-resolve',
  'real-release-converged',
  'real-release-headless-only',
  'cleanup',
  'host-disk',
]

const cleanRun = drive(
  'real-release',
  `declare_scope
   ${laneGreen.map((row) => `pass ${row} green`).join('\n')}
   RUN_STATUS=0
   matrix`,
)

const killedRun = drive(
  'real-release',
  `declare_scope
   pass resource-safety green
   pass coordinator-install green
   pass advertised-url green
   CURRENT_SCENARIO=real-release-install
   # what the SIGTERM trap and cleanup record between them
   RUN_INTERRUPT=SIGTERM
   RUN_STOPPED_AT=real-release-install
   RUN_STATUS=143
   matrix`,
)

const failedRun = drive(
  'real-release',
  `declare_scope
   pass resource-safety green
   pass coordinator-install green
   pass advertised-url green
   CURRENT_SCENARIO=real-release-install
   fail real-release-install "the released install never became healthy"
   RUN_STOPPED_AT=real-release-install
   RUN_STATUS=1
   matrix`,
)

describe('a blank row says why it is blank', () => {
  it('names the lane that excluded it when the selector is the reason', () => {
    // The exact row and lane from the report.
    expect(evidenceFor(cleanRun, 'environment')).toBe(
      'out of scope for PODIUM_UPDATE_E2E_ONLY=real-release',
    )
    expect(evidenceFor(cleanRun, 'environment')).not.toContain('failure')
    // SKIP is still the result. This issue changed how the harness reports, not
    // what any row asserts — an out-of-scope row is not evidence of anything.
    expect(cleanRun).toMatch(/^environment\s+\| SKIP\s+\|/m)
  })

  it('leaves every row the lane DID run untouched', () => {
    for (const row of laneGreen) expect(evidenceFor(cleanRun, row)).toBe('green')
  })

  it('says the run was interrupted, and during which row, when it was killed', () => {
    expect(evidenceFor(killedRun, 'real-release-resolve')).toBe(
      'not reached: the run was INTERRUPTED (SIGTERM) during real-release-install',
    )
    // The row that was in flight when the signal landed is distinguished from the
    // ones after it: it was attempted, they were not.
    expect(evidenceFor(killedRun, 'real-release-install')).toBe(
      'not reached: the run was INTERRUPTED (SIGTERM) while this row was running',
    )
    // And a reader skimming does not have to reconstruct it from a column.
    expect(killedRun).toContain('*** INTERRUPTED:')
    expect(killedRun).toContain('The matrix below is PARTIAL')
  })

  it('names WHICH row failed when a failure really is the reason', () => {
    expect(evidenceFor(failedRun, 'real-release-resolve')).toBe(
      'not reached after real-release-install failed',
    )
    expect(failedRun).not.toContain('*** INTERRUPTED:')
  })

  it('still says out of scope in a lane that FAILED, and in one that was killed', () => {
    // The reason the exclusion is declared before the first row rather than worked
    // out on the way back: a run that dies in the middle never gets to the way
    // back, and `environment` would be swept into the failure with everything
    // else — the same ambiguity in a worse place, because now something really
    // did go wrong and the reader has no way to tell how far it reached.
    expect(evidenceFor(failedRun, 'environment')).toBe(
      'out of scope for PODIUM_UPDATE_E2E_ONLY=real-release',
    )
    expect(evidenceFor(killedRun, 'environment')).toBe(
      'out of scope for PODIUM_UPDATE_E2E_ONLY=real-release',
    )
  })

  it('gives the three situations three different sentences', () => {
    const scoped = evidenceFor(cleanRun, 'environment')
    const killed = evidenceFor(killedRun, 'real-release-resolve')
    const failed = evidenceFor(failedRun, 'real-release-resolve')
    const all = [scoped, killed, failed]
    expect(new Set(all).size).toBe(3)
    // Distinct is not enough — none may read as a prefix or superset of another,
    // which is how "SKIP, not reached" swallowed all three in the first place.
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue
        expect(a.includes(b)).toBe(false)
      }
    }
  })

  it('reports an abort that no row owns as the abort, not as a row failure', () => {
    const aborted = drive(
      '',
      `RUN_ABORT_REASON="missing command 'zig'"
       RUN_STATUS=1
       matrix`,
    )
    expect(evidenceFor(aborted, 'fresh-install')).toBe(
      "not reached: the run aborted before this row — missing command 'zig'",
    )
    // `die` is what sets it, so the two cannot drift apart.
    expect(harness).toContain('die() { RUN_ABORT_REASON="$*";')
  })
})

describe('the harness will not stay silent about a row it lost track of', () => {
  it('calls an unexplained blank row a harness bug rather than guessing', () => {
    // A row nobody ran, nobody scoped out, and no failure explains. Today no lane
    // produces this; the point is that if one ever does, it says so instead of
    // quietly reprinting the sentence this issue was filed about.
    const orphaned = drive(
      'real-release',
      `${laneGreen.map((row) => `pass ${row} green`).join('\n')}
       RUN_STATUS=0
       matrix
       unexplained_rows && echo "RATCHET-FIRES"`,
    )
    expect(evidenceFor(orphaned, 'environment')).toContain('HARNESS BUG')
    expect(orphaned).toContain('RATCHET-FIRES')
  })

  it('does not fire on a run that was interrupted or that failed', () => {
    // Those blanks ARE explained, and a second complaint on top would be noise.
    for (const [label, tail] of [
      ['interrupted', 'RUN_INTERRUPT=SIGTERM\nRUN_STATUS=143'],
      ['failed', 'RUN_STATUS=1'],
    ]) {
      const out = drive(
        'real-release',
        `${tail}
         if unexplained_rows >/dev/null; then echo "FIRED-${label}"; else echo "quiet-${label}"; fi`,
      )
      expect(out).toContain(`quiet-${label}`)
    }
  })

  it('reddens the exit status of a run it cannot explain', () => {
    expect(harness).toContain('if unexplained="$(unexplained_rows)"; then')
    expect(harness).toMatch(/unexplained_rows\)"; then\n\s+say "HARNESS BUG:[\s\S]*?status=1/)
  })
})

describe('the cleanup rows scope_out_remaining must leave alone', () => {
  it('are exactly the rows cleanup() records for itself', () => {
    const body = harness.slice(harness.indexOf('\ncleanup() {'))
    const cleanupBody = body.slice(0, body.indexOf('\n}\n'))
    const recorded = new Set<string>()
    for (const match of cleanupBody.matchAll(
      /^\s*(?:pass|fail|resource|blocked) ([a-z][a-z-]*)/gm,
    )) {
      recorded.add(match[1] as string)
    }
    const declared = /^CLEANUP_ROWS=\(([^)]*)\)/m.exec(harness)?.[1]?.trim().split(/\s+/) ?? []
    // A fourth row recorded in cleanup, or one of these three moving out of it,
    // would otherwise leave `scope_out_remaining` marking a row out of scope that
    // cleanup was about to fill in — a new false line in the same column.
    expect([...recorded].sort()).toEqual([...declared].sort())
  })

  it('are left blank by scope_out_remaining so cleanup can still record them', () => {
    const out = drive(
      'real-release',
      `scope_out_remaining
       for row in "\${CLEANUP_ROWS[@]}"; do printf '%s=%s\\n' "$row" "\${RESULT[$row]:-<blank>}"; done`,
    )
    for (const row of ['resource-safety', 'cleanup', 'host-disk']) {
      expect(out).toContain(`${row}=<blank>`)
    }
  })

  it('is what the legacy lane calls where it stops, being the one lane that cannot declare up front', () => {
    expect(harness).toMatch(
      /fail legacy-sigkill "\$LEGACY_SIGKILL_DECIDED_RED"\n[\s\S]{0,400}?scope_out_remaining\n\s+exit 1/,
    )
    // And the focused lanes do NOT decide it on the way out any more, so a lane
    // that fails halfway keeps its exclusions.
    expect(harness).not.toMatch(/run_server_lane\n\s+CURRENT_SCENARIO=""\n\s+scope_out_remaining/)
    expect(harness).not.toMatch(
      /run_real_release_lane\n\s+CURRENT_SCENARIO=""\n\s+scope_out_remaining/,
    )
  })
})

describe('an exclusion declared before the run, and checked from both sides', () => {
  it('is applied by declare_scope before the first row executes', () => {
    // Ordering is the whole point: after the traps, before `prepare_image`.
    expect(harness).toMatch(
      /trap 'RUN_INTERRUPT=SIGHUP; exit 129' HUP\n(?:\s*#[^\n]*\n)*\s+declare_scope/,
    )
    const beforeFirstRow = harness.indexOf('declare_scope\n  say "run=$RUN_ID')
    expect(beforeFirstRow).toBeGreaterThan(0)
    expect(beforeFirstRow).toBeLessThan(harness.indexOf('CURRENT_SCENARIO=coordinator-install'))
  })

  it('names environment for the real-release lane and nothing for the others', () => {
    const scopeOf = (only: string): string =>
      drive(only, `printf '%s' "\${OUT_OF_SCOPE[*]}"`).trim()
    expect(scopeOf('real-release')).toBe('environment')
    expect(scopeOf('server')).toBe('')
    // The complete matrix runs every row it prints; `legacy` and `positive` are
    // that matrix stopped early, and say so where they stop.
    expect(scopeOf('')).toBe('')
    expect(scopeOf('legacy')).toBe('')
  })

  it('calls a declaration that turns out to be wrong a harness bug', () => {
    // The other direction: if `environment` ever starts running in this lane, the
    // stale declaration must not be able to sit quietly under a real result.
    const stale = drive(
      'real-release',
      `declare_scope
       pass environment "the lane grew an environment row"
       if out="$(stale_scope_declarations)"; then echo "STALE=$out"; else echo "quiet"; fi`,
    )
    expect(stale).toContain('STALE=environment')
    const honest = drive(
      'real-release',
      `declare_scope
       if stale_scope_declarations >/dev/null; then echo "STALE"; else echo "quiet"; fi`,
    )
    expect(honest).toContain('quiet')
    // And cleanup reddens the run on it.
    expect(harness).toMatch(
      /if stale="\$\(stale_scope_declarations\)"; then\n\s+say "HARNESS BUG:[\s\S]*?status=1/,
    )
  })
})

describe('the exit status a caller reads', () => {
  /** Run a bash EXIT trap that ends in `last`, over an original status, and report the process status. */
  function trapStatus(original: number, last: string): number {
    try {
      execFileSync(
        'bash',
        ['-c', `set -Eeuo pipefail; t() { local s=$?; ${last}; }; trap t EXIT; exit ${original}`],
        { encoding: 'utf8' },
      )
      return 0
    } catch (error) {
      return (error as { status: number }).status
    }
  }

  it('separates a killed run from a clean scoped one', () => {
    // The brief's second question. A caller reading only the code must not see
    // the same thing for both, and does not: the signal traps exit 130/143 and
    // bash carries that through the EXIT trap.
    expect(trapStatus(143, 'return "$s"')).toBe(143)
    expect(trapStatus(0, 'return "$s"')).toBe(0)
    expect(harness).toContain("trap 'RUN_INTERRUPT=SIGTERM; exit 143' TERM")
    expect(harness).toContain("trap 'RUN_INTERRUPT=SIGINT; exit 130' INT")
    // A hangup used to kill the run outright: no teardown, no matrix, and the
    // run's containers left behind. It is a way runs die, so it reports like one.
    expect(harness).toContain("trap 'RUN_INTERRUPT=SIGHUP; exit 129' HUP")
  })

  it('is settled by `exit`, which works in both directions, not by a quirk of `return`', () => {
    // Re-derived here rather than remembered, because the obvious belief about
    // this — that an EXIT trap cannot change the status at all — is wrong, and
    // acting on it would have been a rewrite of code that was already correct.
    // What is true: bash honours a NONZERO return from an EXIT trap...
    expect(trapStatus(0, 'return 1')).toBe(1)
    expect(trapStatus(5, 'return 2')).toBe(2)
    // ...and IGNORES a zero one, so `return` can raise a status but never lower
    // it. `cleanup` only ever raises, which is why it worked; `exit` is what
    // keeps it working for an edit that needs the other direction.
    expect(trapStatus(143, 'return 0')).toBe(143)
    expect(trapStatus(143, 'exit 0')).toBe(0)
    expect(harness).toContain('exit "$status"\n}')
    expect(harness).not.toMatch(/^\s+return "\$status"\n}/m)
  })
})
