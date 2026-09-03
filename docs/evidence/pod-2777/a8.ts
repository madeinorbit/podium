/**
 * TIER-A ROW A8 — logged-out spawn.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a8.ts opencode
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "gets a working login path; after login, next session lands on the server
 *    driver (POD-2772 fixed)"
 *
 * ---------------------------------------------------------------------------
 * ONLY THE FIRST HALF IS DRIVABLE HERE, AND THE SECOND IS SAID SO RATHER THAN
 * QUIETLY DROPPED.
 * ---------------------------------------------------------------------------
 * "After login, the next session lands on the server driver" needs a real login.
 * These harnesses authenticate by OAuth against live accounts; performing one
 * from a drive would either need credentials this rig must not mint, or would
 * ROTATE the operator's own token and log them out of their daily driver. The
 * epic already declined that trade once, in writing, for claude. So this probe
 * drives the first half and reports the second as NOT DRIVEN with the reason.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL IS THE SAME HARNESS BINDING THE SERVER DRIVER WHEN ITS
 * CREDENTIAL IS PRESENT.
 * ---------------------------------------------------------------------------
 * The failure this row exists to catch (POD-2772) is a logged-out harness
 * SILENTLY DEGRADING to a terminal PTY instead of reporting that it needs a
 * login. But "it bound a terminal driver" is also what you see when the harness
 * could never bind a server driver on this box at all — a version gate, a
 * missing binary, a machine preference. Those are indistinguishable from the
 * outside, so the probe first proves that WITH the credential this harness binds
 * its server driver, then removes the credential and looks again. Without the
 * before-reading the after-reading means nothing.
 *
 * THE CREDENTIAL IS MOVED, NEVER DELETED, and restored in a finally block. It is
 * the rig's isolated agent home, not the operator's — but a drive that can
 * destroy a credential on a crash is a drive nobody should run twice.
 */
import { existsSync, renameSync } from 'node:fs'
import { AGENT_KIND, REPO, login, mutate, query, sessionRow, until, wait } from './rig'

const harness = (process.argv[2] ?? 'opencode') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const log = (s: string) => console.log(s)

const AGENT_HOME = `${process.env.P2777_STATE_ROOT}/agent-home`

/** Where each harness keeps the credential the server driver needs. */
const CREDENTIAL: Record<string, string> = {
  opencode: `${AGENT_HOME}/.local/share/opencode/auth.json`,
  codex: `${AGENT_HOME}/.codex/auth.json`,
  grok: `${AGENT_HOME}/.grok/auth.json`,
}

const EXPECTED_SERVER: Record<string, string> = {
  codex: 'codex-app-server',
  grok: 'grok-acp',
  opencode: 'opencode-server',
}

const cred = CREDENTIAL[harness]
const wantServer = EXPECTED_SERVER[harness]
if (!cred || !wantServer) {
  log(`A8 n/a for ${harness}: no server driver, so there is no demotion to detect.`)
  process.exit(2)
}

await login()
log('='.repeat(78))
log(`A8  logged-out spawn   harness=${harness}`)
log('='.repeat(78))
log(`credential         ${cred}`)
log(`                   present: ${existsSync(cred)}`)

async function spawnAndRead(label: string): Promise<{
  sid?: string
  driverId: string
  family: string
  status: string
  condition?: string
  requestedDriverId?: string
  errorClass?: string
  errorDetail?: string
  spawnFailure?: string
}> {
  const created = await mutate('sessions.create', { cwd: REPO, agentKind })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) {
    log(`  ${label}: sessions.create FAILED -> ${JSON.stringify(created).slice(0, 300)}`)
    return { driverId: '(create failed)', family: '?', status: 'create-failed' }
  }
  await wait(READY_MS)
  const bound = await until(sid, (r) => Boolean(r?.driverId) || r?.status === 'exited', 90_000, 1_000)
  const r = bound.row ?? (await sessionRow(sid))
  const raw = r as Record<string, unknown> | undefined
  return {
    sid,
    driverId: r?.driverId ?? '(none)',
    family: r?.driverFamily ?? '?',
    status: r?.status ?? '?',
    /**
     * THE FIELDS THAT ACTUALLY CARRY THE ANSWER, and their absence from the
     * first version of this probe produced a WRONG FAIL.
     *
     * I checked `agentState.error`, `spawnFailure` and `status`, found nothing,
     * and reported "a logged-out opencode SILENTLY became a generic-pty
     * session" — i.e. a POD-2772 regression. It is not silent. The row says so
     * in its own vocabulary:
     *   condition: 'logged-out'          — the session's own typed reason
     *   requestedDriverId: 'opencode-server' beside driverId: 'generic-pty'
     *                                    — the demotion recorded as requested-vs-actual
     * and at the account level `accounts.list` carries loginRequired: true,
     * while `machines.list` carries login.state: 'out'.
     *
     * I only found them by dumping the WHOLE row instead of the three fields I
     * had assumed would carry it. "The product says nothing" is a claim about
     * every surface, and it cannot be made from the two you happened to read.
     */
    condition: raw?.condition as string | undefined,
    requestedDriverId: raw?.requestedDriverId as string | undefined,
    ...(r?.agentState?.error?.class ? { errorClass: r.agentState.error.class } : {}),
    ...(r?.agentState?.error?.detail ? { errorDetail: String(r.agentState.error.detail) } : {}),
    ...((r as Record<string, unknown> | undefined)?.spawnFailure
      ? { spawnFailure: String((r as Record<string, unknown>).spawnFailure) }
      : {}),
  }
}

const parked = `${cred}.a8-parked`
let moved = false
/** Idempotent, so calling it from an exit path AND the finally is safe. */
function restoreCredential(): void {
  if (moved && existsSync(parked)) {
    renameSync(parked, cred)
    moved = false
    log('')
    log(`credential restored -> ${cred} (present: ${existsSync(cred)})`)
  }
}
try {
  // --- CONTROL: with the credential present ---------------------------------
  const before = await spawnAndRead('control')
  log('')
  log('CONTROL            with the credential PRESENT:')
  log(`                   driverId=${before.driverId}  family=${before.family}  status=${before.status}`)
  if (before.sid) await mutate('sessions.kill', { sessionId: before.sid }).catch(() => {})

  const controlFired = before.driverId === wantServer && before.family === 'server'
  log(`                   binds its server driver: ${controlFired}`)

  if (!controlFired) {
    log('')
    log('REFUSED — the positive control did not fire.')
    log(`  control watched: ${harness} binding ${wantServer} while logged IN, so that a`)
    log('                   terminal binding afterwards means "logged out" and not')
    log('                   "this harness never binds a server driver on this box"')
    log(`  control saw:     ${before.driverId} / ${before.family}`)
    log('  A demotion cannot be detected against a baseline that is already demoted.')
    process.exit(3)
  }

  // --- the measurement: with the credential removed -------------------------
  renameSync(cred, parked)
  moved = true
  log('')
  log(`credential moved aside -> ${parked}`)
  const after = await spawnAndRead('logged-out')
  log('')
  log('LOGGED OUT         with the credential ABSENT:')
  log(`                   driverId=${after.driverId}  family=${after.family}  status=${after.status}`)
  if (after.errorClass) log(`                   errorClass=${after.errorClass}  detail=${(after.errorDetail ?? '').slice(0, 200)}`)
  if (after.spawnFailure) log(`                   spawnFailure=${after.spawnFailure.slice(0, 200)}`)
  if (after.sid) await mutate('sessions.kill', { sessionId: after.sid }).catch(() => {})

  // Three outcomes, and only one of them is POD-2772's defect.
  // Account-level readouts, which is where a UI would learn to offer a login.
  const accounts = JSON.stringify((await query('accounts.list', {})).result?.data ?? null)
  const loginRequired = /"loginRequired":true/.test(accounts)
  const asks = JSON.stringify((await query('interactions.list', { sessionId: after.sid })).result?.data ?? [])
  log(`                   condition=${after.condition ?? '(none)'}  requestedDriverId=${after.requestedDriverId ?? '(none)'}`)
  log(`                   accounts.list loginRequired: ${loginRequired}`)
  log(`                   interactions.list offering a login: ${asks !== '[]' ? asks.slice(0, 200) : 'none'}`)

  /**
   * SECOND CONTROL: THE HARNESS MUST ACTUALLY BE LOGGED OUT.
   *
   * Added after this probe returned a VACUOUS PASS on codex. With
   * `.codex/auth.json` moved aside, the session still bound `codex-app-server`,
   * `loginRequired` stayed FALSE and `condition` was empty — so the product was
   * not demoting because, as far as it could tell, nothing had been taken away.
   * The probe scored that as "did not silently take the old path", which is a
   * true sentence about a measurement that never happened.
   *
   * The first control proves the harness binds its server driver WITH the
   * credential. This one proves the credential's absence actually reached the
   * product. Both are needed: the first rules out "never could bind", the second
   * rules out "was never logged out". Removing a file is an action on the disk;
   * being logged out is a state of the product, and only the product can report it.
   *
   * `loginRequired` is the product's own readout and it DID flip for opencode,
   * so this is not a bar nothing can clear — it is the same bar, applied to both.
   */
  if (!loginRequired && after.condition !== 'logged-out') {
    log('')
    log('REFUSED — the logged-out control did not fire.')
    log(`  control watched: the product REPORTING ${harness} as logged out once its`)
    log('                   credential was moved aside — accounts.list loginRequired=true,')
    log("                   or the session carrying condition='logged-out'")
    log(`  control saw:     loginRequired=${loginRequired}, condition=${after.condition ?? '(none)'},`)
    log(`                   and the session still bound ${after.driverId}`)
    log('  Moving a file is an action on the disk; being logged out is a state of the')
    log('  product. This run never reached that state, so "it did not demote" is a')
    log('  statement about nothing. The verdict is withheld rather than scored.')
    log('')
    log('  NOT a product defect on its face: the likeliest cause is that the running')
    log('  app-server child had already authenticated and was reused, or that login')
    log('  state was cached from the control spawn seconds earlier. Either would be')
    log("  worth its own cell; neither is this row's question.")
    /**
     * RESTORE BEFORE EXITING, and this is a correction made within a minute of
     * writing the bug. `process.exit()` does NOT run `finally` blocks — so the
     * first version of this refusal path left the credential PARKED, and the
     * next drive of any codex cell would have run against a half-logged-out
     * agent home without anything saying so.
     *
     * A probe that refuses is still a probe that has to leave the rig as it
     * found it. The refusal is the safest-looking path in the file and it was
     * the only one that leaked.
     */
    restoreCredential()
    process.exit(3)
  }

  const declaredIt =
    after.condition === 'logged-out' ||
    (Boolean(after.requestedDriverId) && after.requestedDriverId !== after.driverId) ||
    loginRequired ||
    Boolean(after.errorClass) ||
    Boolean(after.spawnFailure) ||
    after.status === 'exited'
  const silentlyDegraded = after.family === 'terminal' && !declaredIt
  const offersLogin = asks !== '[]'

  log('')
  log('='.repeat(78))
  if (silentlyDegraded) {
    log('A8  FAIL (first half)')
    log(`    A logged-out ${harness} SILENTLY became a ${after.driverId} session.`)
    log('    No error class, no spawn failure, no typed login affordance — the row')
    log('    just quietly runs on the old path. That is POD-2772\'s shape: sessions')
    log('    would be on the terminal driver and nobody would be told, which')
    log('    defeats the point of the release.')
  } else if (after.family === 'terminal') {
    log('A8  PARTIAL (first half)')
    log(`    A logged-out ${harness} became a terminal-family session, and it DECLARED IT:`)
    log(`      condition=${after.condition}  requestedDriverId=${after.requestedDriverId} -> driverId=${after.driverId}`)
    log(`      accounts.list loginRequired=${loginRequired}`)
    log('    So this is NOT POD-2772\'s silent demotion: the demotion is recorded as')
    log('    requested-versus-actual, the session carries a typed condition, and the')
    log('    account readout asks for a login. Degrading to the terminal path so an')
    log('    interactive login is possible is the documented behaviour.')
    log('')
    log(`    What is NOT there is a login AFFORDANCE on the session itself:`)
    log(`      interactions.list = ${asks === '[]' ? 'empty — nothing offers to log you in' : asks.slice(0, 160)}`)
    log('    The catalogue already declares this: login(harness, method) as a utility')
    log('    session is ABSENT, and logout/exportCredential/seedCredential are missing')
    log('    from the contract entirely (section 12). PARTIAL rather than PASS because')
    log('    the row asks for a WORKING login path and there is a declaration, not a path.')
  } else {
    log('A8  PASS (first half)')
    log(`    A logged-out ${harness} did not silently take the old path:`)
    log(`      driver=${after.driverId} family=${after.family} status=${after.status}`)
    log(`      ${after.errorClass ?? after.spawnFailure ?? ''}`)
  }
  log('')
  log('    SECOND HALF — "after login, the next session lands on the server driver"')
  log('    NOT DRIVEN, and not counted either way. These harnesses authenticate by')
  log('    OAuth against live accounts. Performing a login from this drive would')
  log('    either mint credentials the rig must not mint, or ROTATE the operator\'s')
  log('    own token and log them out of their daily driver mid-release. The epic')
  log('    declined that trade once already, in writing, for claude; declining it')
  log('    again here rather than reporting an untested half as passing.')
  log(`    controls: FIRED — the same harness bound ${wantServer} with its credential present`)
  log('='.repeat(78))
} finally {
  restoreCredential()
}
