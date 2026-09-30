import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// POD-2747: `agent-survival` reported that the fleet's abduco masters had not
// survived the self-handover while the containers' own journals showed both
// masters still attached, on their original PIDs, straight through the successor
// swap. The row was red for the harness's bookkeeping, not the product.
//
// Since POD-4986 new sessions run under podium-host and abduco sessions are only
// ADOPTED — the ones an older release started, which a machine updating from v0.1.0
// or an edge build keeps. The survival row therefore records each session's durable
// owner (a process host, or an attached abduco master) and requires the same one
// after the handover; an abduco master counts only while a client is attached, since
// that attachment is the new daemon's re-adoption.
//
// The cause is the call shape, so the call shape is what these tests pin.
// `wait_for` runs its predicate as `last="$("$@" 2>&1)"` — a command
// substitution, hence a subshell — and the capture (then `capture_abduco_state`,
// now `capture_durable_state`) recorded the masters into a shell global that died
// with it. Two of the three call sites go
// through `wait_for`, including the re-capture that runs whenever the shells had
// to be re-created, which is the path a real run takes.
//
// So every capture below goes through `wait_for`, exactly as the gate does. A
// capture that only works when called directly is the bug, not the fix.

const ROOT = join(import.meta.dirname, '..')
const GATE = join(ROOT, 'scripts/docker-update-e2e.sh')

/** One attached abduco listing row: `*`, weekday, timestamp, master PID, label. */
function attached(pid: number, session: string): string {
  return `* Mon\\t 2026-08-24 21:38:40\\t${pid}\\tpodium-update-e2e-${session}`
}

/** The same session with no `*`: abduco knows the name, nothing is attached to it. */
function detached(pid: number, session: string): string {
  return `  Mon\\t 2026-08-24 21:38:40\\t${pid}\\tpodium-update-e2e-${session}`
}

/** One process-host row as `host_listing` prints it: PID, then the host's argv. */
function hosted(pid: number, session: string): string {
  return `${pid}\\t/home/podium/.local/share/podium/podium-host create --socket /run/user/1000/hosts/e2e/podium-update-e2e-${session}.sock -- /bin/bash`
}

interface Fleet {
  /** Listing rows for fleet-a, then fleet-b, as abduco would print them. */
  readonly before: readonly [string, string]
  readonly after: readonly [string, string]
  /** Process-host rows for fleet-a, then fleet-b; absent means no hosts at all. */
  readonly hostsBefore?: readonly [string, string]
  readonly hostsAfter?: readonly [string, string]
  /**
   * Make `kill -0` report the listed masters dead AFTER the baseline is taken.
   *
   * Not before: failing the capture too would refuse survival for the missing
   * baseline and never reach the liveness check, which is a test that passes
   * without exercising what it names. Mutating that check away proved it.
   */
  readonly mastersDieAfterCapture?: boolean
  /** Skip the capture entirely, leaving the survival check with no baseline. */
  readonly skipCapture?: boolean
}

/**
 * Run one capture/survive cycle against the real helpers.
 *
 * Only the container edges are stubbed — the abduco listing, the host listing and
 * `docker` — so `capture_durable_state`, `durable_sessions_survived`,
 * `durable_owner` and `wait_for` are the shipped code under test.
 */
async function cycle(fleet: Fleet): Promise<{ stdout: string; stderr: string; status: number }> {
  const listing = (rows: readonly [string, string]) =>
    `[fa]="${rows[0]}" [fb]="${rows[1]}"`
  const snippet = `
set -Eeuo pipefail
shopt -s inherit_errexit
source ${JSON.stringify(GATE)}
WORK="$(mktemp -d)"; mkdir -p "$WORK/logs"
FLEET_A=fa; FLEET_B=fb
IDS='["s1","s2"]'
declare -A BEFORE=(${listing(fleet.before)})
declare -A AFTER=(${listing(fleet.after)})
declare -A NOW=()
declare -A HOSTS_BEFORE=(${listing(fleet.hostsBefore ?? ['', ''])})
declare -A HOSTS_AFTER=(${listing(fleet.hostsAfter ?? ['', ''])})
declare -A HOSTS_NOW=()
abduco_listing() { printf 'Active sessions\\n'; [[ -n "\${NOW[$1]}" ]] && printf "\${NOW[$1]}\\n"; return 0; }
host_listing() { [[ -e "$WORK/masters-dead" ]] && return 1; [[ -n "\${HOSTS_NOW[$1]}" ]] && printf "\${HOSTS_NOW[$1]}\\n"; return 0; }
docker() { [[ -e "$WORK/masters-dead" ]] && return 1; return 0; }
for k in fa fb; do NOW[$k]="\${BEFORE[$k]}"; HOSTS_NOW[$k]="\${HOSTS_BEFORE[$k]}"; done
${
  fleet.skipCapture
    ? 'echo "capture: skipped"'
    : `if wait_for 5 "masters" capture_durable_state "$IDS"; then echo "capture: ok"; else echo "capture: refused"; fi`
}
if [[ -s "$WORK/logs/durable-baseline.tsv" ]]; then
  echo "baseline: $(tr '\\t' ' ' <"$WORK/logs/durable-baseline.tsv" | tr '\\n' ';')"
else
  echo "baseline: none"
fi
for k in fa fb; do NOW[$k]="\${AFTER[$k]}"; HOSTS_NOW[$k]="\${HOSTS_AFTER[$k]}"; done
${fleet.mastersDieAfterCapture ? 'touch "$WORK/masters-dead"' : ''}
if durable_sessions_survived "$IDS"; then echo "survived: yes"; else echo "survived: no"; fi
`
  try {
    const { stdout, stderr } = await promisify(execFile)('bash', ['-c', snippet], {
      encoding: 'utf8',
    })
    return { stdout, stderr, status: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.code ?? -1 }
  }
}

const LIVE = [attached(709, 's1'), attached(439, 's2')] as const

describe('adopted abduco master survival across a self-handover', () => {
  it('reports survival when both masters keep their PIDs through a wait_for capture', async () => {
    // The regression guard. This is the observed run — fleet-a on 709, fleet-b on
    // 439, unchanged across the handover — and before the fix it reported "no".
    const run = await cycle({ before: LIVE, after: LIVE })
    expect(run.stdout).toContain('capture: ok')
    expect(run.stdout).toContain('baseline: fa s1 abduco 709;fb s2 abduco 439;')
    expect(run.stdout).toContain('survived: yes')
  })

  it('refuses survival when a master PID moved', async () => {
    const run = await cycle({
      before: LIVE,
      after: [attached(709, 's1'), attached(4711, 's2')],
    })
    expect(run.stdout).toContain('survived: no')
  })

  it('refuses survival when a master is gone from its host', async () => {
    const run = await cycle({ before: LIVE, after: [attached(709, 's1'), ''] })
    expect(run.stdout).toContain('survived: no')
  })

  it('refuses survival when the session outlived its attachment', async () => {
    // abduco still holds the name but nothing is attached: the shell did not
    // survive in the sense the row claims.
    const run = await cycle({
      before: LIVE,
      after: [attached(709, 's1'), detached(439, 's2')],
    })
    expect(run.stdout).toContain('survived: no')
  })

  it('refuses survival, and says why, when no baseline was ever captured', async () => {
    // The failure the bug produced. It must read as "nothing was recorded",
    // never as "the masters did not survive".
    const run = await cycle({ before: LIVE, after: LIVE, skipCapture: true })
    expect(run.stdout).toContain('baseline: none')
    expect(run.stdout).toContain('survived: no')
    expect(run.stderr).toContain('no durable-session baseline was captured')
  })

  it('publishes no baseline at all when only some masters were found', async () => {
    // A half-captured baseline would let the survival check compare the masters
    // it happened to see and call that a survival.
    const run = await cycle({ before: [attached(709, 's1'), ''], after: LIVE })
    expect(run.stdout).toContain('capture: refused')
    expect(run.stdout).toContain('baseline: none')
    expect(run.stdout).toContain('survived: no')
  })

  it('refuses survival when a listed master is not actually alive', async () => {
    // abduco's listing is a socket-directory read: it can still name a master
    // whose process is gone. The baseline must be captured first, or this
    // refuses for the missing baseline and never checks liveness at all.
    const run = await cycle({ before: LIVE, after: LIVE, mastersDieAfterCapture: true })
    expect(run.stdout).toContain('baseline: fa s1 abduco 709;fb s2 abduco 439;')
    expect(run.stdout).toContain('survived: no')
  })
})

const HOSTED = [hosted(812, 's1'), hosted(913, 's2')] as const
const NONE = ['', ''] as const

describe('process-host survival across a self-handover', () => {
  it('reports survival when both hosts keep their PIDs', async () => {
    const run = await cycle({ before: NONE, after: NONE, hostsBefore: HOSTED, hostsAfter: HOSTED })
    expect(run.stdout).toContain('capture: ok')
    expect(run.stdout).toContain('baseline: fa s1 host 812;fb s2 host 913;')
    expect(run.stdout).toContain('survived: yes')
  })

  it('refuses survival when a host PID moved', async () => {
    const run = await cycle({
      before: NONE,
      after: NONE,
      hostsBefore: HOSTED,
      hostsAfter: [hosted(812, 's1'), hosted(4711, 's2')],
    })
    expect(run.stdout).toContain('survived: no')
  })

  it('refuses survival when an adopted abduco session turned up under a new host', async () => {
    // A different owner is a different session, whatever it is called.
    const run = await cycle({
      before: LIVE,
      after: NONE,
      hostsAfter: [hosted(709, 's1'), hosted(439, 's2')],
    })
    expect(run.stdout).toContain('baseline: fa s1 abduco 709;fb s2 abduco 439;')
    expect(run.stdout).toContain('survived: no')
  })
})
