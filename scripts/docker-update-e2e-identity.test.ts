import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// POD-2747: two assertions in this gate carried expectations that had quietly
// stopped being true, and neither could be caught by running the gate, because
// each aborted the row before the next one was reached.
//
//   `rollback` tested the minted version against `\.dev\.` — a DOT before `dev`
//   — while the publisher mints `X.Y.Z-dev.N+sha` with a HYPHEN. `dev-release`
//   asserts the identical contract and was corrected 37 minutes after both were
//   written; this copy was missed, so the row could not pass on any build. The
//   contract now has one implementation and these tests pin its grammar.
//
//   `restart_coordinator` then asserted the coordinator still served
//   $BOOTSTRAP_VERSION. The coordinator updates itself in the wave like any
//   other machine, so that expired the moment `rollout` succeeded — and went
//   unnoticed because `rollback` was the only caller downstream of a successful
//   update and it never got that far.

const ROOT = join(import.meta.dirname, '..')
const GATE = join(ROOT, 'scripts/docker-update-e2e.sh')

async function bash(snippet: string): Promise<{ stdout: string; stderr: string }> {
  const script = `set -Eeuo pipefail\nshopt -s inherit_errexit\nsource ${JSON.stringify(GATE)}\n${snippet}\n`
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', ['-c', script], {
      encoding: 'utf8',
    })
    return { stdout, stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** Ask the real `proposal_identity_holds` about one payload. */
async function identity(proposal: object, expected?: string): Promise<string> {
  const args = expected === undefined ? '"$P"' : `"$P" ${JSON.stringify(expected)}`
  const run = await bash(
    `P=${JSON.stringify(JSON.stringify(proposal))}
if proposal_identity_holds ${args}; then echo held; else echo refused; fi`,
  )
  return run.stdout.trim()
}

/** Ask the real `rollback_outcome_holds` about one terminal operation. */
async function rollbackOutcome(operation: object): Promise<string> {
  const run = await bash(
    `V=${JSON.stringify(JSON.stringify(operation))}
if rollback_outcome_holds "$V"; then echo held; else echo refused; fi`,
  )
  return run.stdout.trim()
}

/** Ask the real `coordinator_is_installed_build` about one /version body. */
async function installedBuild(body: object, expected?: string): Promise<string> {
  const run = await bash(
    `INSTANCE=update-e2e
BOOTSTRAP_VERSION=0.1.1-edge.2
http_request() { HTTP_BODY=${JSON.stringify(JSON.stringify(body))}; return 0; }
if coordinator_is_installed_build ${expected === undefined ? '' : JSON.stringify(expected)}; then echo ok; else echo refused; fi`,
  )
  return run.stdout.trim()
}

// The two payloads the gate actually produced, copied from the run evidence.
const DEV_RELEASE = {
  headSha: 'f48a546',
  version: '0.1.2-dev.1+f48a546',
  branch: 'update-e2e-source',
  state: 'pending',
}
const ROLLBACK = {
  headSha: 'cf7dcaf',
  version: '0.1.2-dev.2+cf7dcaf',
  branch: 'update-e2e-source',
  state: 'pending',
}

describe('the HEAD/version identity contract', () => {
  it('holds for the real dev-release and rollback proposals', async () => {
    // The rollback payload is the one the failing run produced. Before the fix
    // it was refused, and the row named a line rather than a disagreement.
    expect(await identity(DEV_RELEASE)).toBe('held')
    expect(await identity(ROLLBACK)).toBe('held')
    expect(await identity(ROLLBACK, 'cf7dcaf')).toBe('held')
  })

  it('refuses the dotted form that is not what the publisher mints', async () => {
    // The exact defect: `0.1.2.dev.2+…` would satisfy the old `\.dev\.` test and
    // is not a version this publisher can produce.
    expect(await identity({ ...ROLLBACK, version: '0.1.2.dev.2+cf7dcaf' })).toBe('refused')
  })

  it('refuses a version whose build metadata names a different commit', async () => {
    expect(await identity({ ...ROLLBACK, version: '0.1.2-dev.2+deadbee' })).toBe('refused')
  })

  it('refuses a proposal for a commit the caller did not ask about', async () => {
    expect(await identity(ROLLBACK, 'abc1234')).toBe('refused')
  })

  it('refuses an abbreviation longer than seven characters', async () => {
    // `git rev-parse --short=7` returns MORE than seven characters when the
    // prefix is ambiguous. The old truncating slice would have matched anyway.
    expect(await identity({ headSha: 'cf7dcafa', version: '0.1.2-dev.2+cf7dcafa', state: 'pending' }, 'cf7dcafa')).toBe('refused')
  })

  it('refuses dev.0, a release version, and a proposal already consumed', async () => {
    expect(await identity({ ...ROLLBACK, version: '0.1.2-dev.0+cf7dcaf' })).toBe('refused')
    expect(await identity({ ...ROLLBACK, version: '0.1.2' })).toBe('refused')
    expect(await identity({ ...ROLLBACK, state: 'approved' })).toBe('refused')
  })
})

describe('the rollback row reads the outcome code, not the prose', () => {
  // The operation a real gate run produced when the crashing canary rolled back.
  // Note what it does NOT contain: rollback, rolled back, stuck, health,
  // successor. The row used to grep the JSON for exactly those five words.
  const REAL = {
    state: 'failed',
    error: {
      code: 'machine-update-not-confirmed',
      message:
        'fleet-a took this update but did not come back on the new version, and is running again on the version it had.',
      detail: 'attempt 2 of 2 did not reach 0.1.2-dev.2+5f5c049 (running 0.1.2-dev.1+a029ce1)',
    },
  }

  it('holds for the operation a real rollback produced', async () => {
    expect(await rollbackOutcome(REAL)).toBe('held')
  })

  it('would not have been matched by the prose it replaced', async () => {
    // Pins the diagnosis, not just the fix: this payload is correct in every
    // respect and the old vocabulary check refused it.
    const words = /rollback|rolled back|stuck|health|successor/i
    expect(words.test(JSON.stringify(REAL))).toBe(false)
  })

  it('refuses a crash bundle that failed verification instead of crashing on boot', async () => {
    // machine-artifact-rejected is tampered-refusal's outcome. If this row ever
    // ends that way the crash artifact was not served intact, and it must not
    // read as a passing rollback.
    expect(await rollbackOutcome({ ...REAL, error: { ...REAL.error, code: 'machine-artifact-rejected' } })).toBe(
      'refused',
    )
  })

  it('refuses a delivery failure, a missing error, and an operation that succeeded', async () => {
    expect(await rollbackOutcome({ ...REAL, error: { ...REAL.error, code: 'machine-delivery-failed' } })).toBe(
      'refused',
    )
    expect(await rollbackOutcome({ state: 'failed', error: null })).toBe('refused')
    expect(await rollbackOutcome({ ...REAL, state: 'done' })).toBe('refused')
  })
})

describe('the coordinator came back as an installed build', () => {
  const BOOTSTRAP = { instanceId: 'update-e2e', appVersion: '0.1.1-edge.2', installKind: 'installed' }
  const ROLLED_OUT = { instanceId: 'update-e2e', appVersion: '0.1.2-dev.1+316f98f', installKind: 'installed' }

  it('accepts the bootstrap build when no version is named', async () => {
    expect(await installedBuild(BOOTSTRAP)).toBe('ok')
  })

  it('accepts the rolled-out version the wave moved the coordinator onto', async () => {
    // The regression guard. `rollout` leaves source, fleet-a and fleet-b all on
    // this version; asserting the bootstrap build here is what failed the row.
    expect(await installedBuild(ROLLED_OUT, '0.1.2-dev.1+316f98f')).toBe('ok')
  })

  it('still refuses the rolled-out version when the caller expected bootstrap', async () => {
    // The parameter must not become a way of accepting anything: a caller that
    // names no version still holds the coordinator to the bootstrap build.
    expect(await installedBuild(ROLLED_OUT)).toBe('refused')
  })

  it('refuses a checkout build even when the version is the one expected', async () => {
    // The half with no expiry: the coordinator must not fall back to running
    // from the source tree.
    expect(await installedBuild({ ...BOOTSTRAP, appVersion: 'dev+316f98f' })).toBe('refused')
    expect(await installedBuild({ ...ROLLED_OUT, appVersion: 'dev+316f98f' }, 'dev+316f98f')).toBe(
      'refused',
    )
  })

  it('refuses another instance answering on the port', async () => {
    expect(await installedBuild({ ...BOOTSTRAP, instanceId: 'somebody-else' })).toBe('refused')
  })
})
