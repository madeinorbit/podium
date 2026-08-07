/**
 * Hermetic test environment [spec:SP-b85a].
 *
 * Runs before every test file — wired as vitest `setupFiles` (vitest.config.ts) and as a
 * `bun test` preload (bunfig.toml `[test].preload`), so BOTH runners get it. Its job: strip
 * the ambient Podium agent-session env so a suite launched from INSIDE a live agent session
 * cannot touch, or be hijacked by, the live instance.
 *
 * Why this is needed: a session carries PODIUM_SESSION_RELAY (+ PODIUM_AGENT_RELAY when it is
 * an agent, PODIUM_SESSION_ID, PODIUM_PORT) in its env, and stateDir() falls back to ~/.podium
 * when PODIUM_STATE_DIR is unset.
 * Any test that reads process.env without overriding it would otherwise route through
 * the session relay, dial the live server on :18787, or open the live ~/.podium/podium.db —
 * i.e. "separate instances can't be tested; they conflict with the main instance" (POD-555).
 *
 * The scrub mirrors resolveAgentRelay()'s escape hatch:
 *  - drop the session-identity + instance-targeting vars, so nothing inherits them;
 *  - set PODIUM_NO_RELAY=1, so resolveAgentRelay() AND resolveSessionRelay() return
 *    undefined (act as operator, not "this session") for any code that reads the live
 *    process.env;
 *  - point PODIUM_STATE_DIR at a per-file throwaway so stateDir() never resolves to
 *    ~/.podium. A suite that sets its own PODIUM_STATE_DIR keeps it.
 *
 * PER-FILE CONTAINERS [POD-527 / POD-553]
 * Vitest re-imports this setup file per test file (it invalidates the module first, even
 * with isolation off), so a re-evaluation mints a fresh container and state root. A bun
 * preload runs ONCE per process, and `bun test` runs every file of an invocation in that
 * process — so without a second trigger, every file after the first would inherit the first
 * file's roots (POD-553). `mintHermeticFileScope()` is that trigger: bun hooks call it on
 * each file boundary (see test-hermetic-bun-hooks.ts). Module-scope state is keyed on
 * globalThis so a second evaluation (or an explicit remint) does not nest containers or
 * stack exit listeners.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertHermeticStateDir } from './test-hermetic-state-guard'

// PODIUM_CODEX_HOOK_* (the codex hook ingest locator — PODIUM_CODEX_HOOK_URL today, plus any
// locator POD-565's official-hooks migration adds) is scrubbed by prefix so a codex session's
// tests can't POST to the live daemon's hook ingest. It rides its OWN transport, separate from
// the generic agent relay — PODIUM_NO_RELAY deliberately does NOT gate it (it only shorts
// resolveAgentRelay()), so we drop it here instead.
// The instance-identity vars (docs/multi-instance.md) are scrubbed too: a suite launched from
// inside a NAMED instance's session would otherwise inherit that identity — resolveInstance()
// reads PODIUM_INSTANCE, and the port/agent-home/adopt overrides retarget the live deployment.
// Tests always run as the hermetic per-file throwaway, never as the hosting instance.
const SCRUB_EXACT = new Set([
  'PODIUM_AGENT_RELAY',
  'PODIUM_SESSION_RELAY',
  'PODIUM_ISSUE_RELAY',
  'PODIUM_SESSION_ID',
  'PODIUM_PORT',
  'PODIUM_INSTANCE',
  'PODIUM_HOOK_PORT',
  'PODIUM_AGENT_RELAY_PORT',
  'PODIUM_AGENT_HOME',
  'PODIUM_ADOPT_STATE',
  // A suite launched from inside an abduco-attached agent session inherits these;
  // leaving them set makes child `abduco` think it is already attached and confuses
  // list/create against the live master's socket (durable-backend tests).
  'ABDUCO_SOCKET',
  'ABDUCO_SESSION',
])
for (const key of Object.keys(process.env)) {
  if (SCRUB_EXACT.has(key) || key.startsWith('PODIUM_CODEX_HOOK_')) {
    delete process.env[key]
  }
}
process.env.PODIUM_NO_RELAY = '1'

// A live Podium session may prepend helper shims below ~/.podium to PATH. Even when tests use
// an isolated PODIUM_STATE_DIR, every child command lookup would still stat that live tree.
// Remove the default live state root and its descendants before any test or agent CLI starts.
const liveDefaultStateDir = join(homedir(), '.podium')
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(delimiter)
    .filter((entry) => {
      if (!entry) return true
      const pathFromLiveState = relative(liveDefaultStateDir, resolve(entry))
      const isWithinLiveState =
        pathFromLiveState === '' ||
        (pathFromLiveState !== '..' &&
          !pathFromLiveState.startsWith(`..${sep}`) &&
          !isAbsolute(pathFromLiveState))
      return !isWithinLiveState
    })
    .join(delimiter)
}

// ---- tmp-dir containment [spec:SP-0be7] (POD-518) -------------------------------------------
// INVARIANT: everything a test file (and any child it spawns) writes to "tmp" lands inside ONE
// container dir that is removed once that file is done. A full-suite run used to leak
// ~660 dirs / 84MB into /tmp per run (POD-518; /tmp hit 143k entries) because 181 mkdtemp
// sites across 44 test files had no cleanup — worst case a real ~/.codex/auth.json copied
// into a world-readable /tmp home for up to 30 days.
//
// Mechanism: create the container in the ORIGINAL tmpdir, then point TMPDIR at it. Verified
// (bun 1.x and node both) that os.tmpdir() re-reads TMPDIR at call time, so every subsequent
// os.tmpdir()/mkdtemp in this process is contained; child processes inherit process.env, so
// their tmp writes are contained too. Cleanup: `releaseHermeticTmpContainer()` at file end
// (when a caller has one), with process 'exit' and best-effort signal handlers as the
// backstop — a SIGKILLed fork still leaks its dirs, but the prefix 'podium-test-run-' is safe
// to sweep.
//
// The state below is keyed on globalThis rather than on this module's scope, because module
// scope is exactly what a re-evaluation (vitest) or a second mint (bun hooks) must not lose
// track of. [POD-527] [POD-553]
interface HermeticTmpState {
  /** Containers this process created and has not released yet. */
  containers: string[]
  /** The tmp root the process started with, captured before any container replaced TMPDIR. */
  hostTmpdir: string
  /** The last PODIUM_STATE_DIR this module assigned — how it tells its own from a caller's. */
  assignedStateDir?: string
  /** Active per-file container currently published as TMPDIR. */
  activeContainer?: string
  /** Last bun-test file key (Bun.main) this process minted for — detects file boundaries. */
  activeFileKey?: string
  exitHandlersInstalled?: boolean
}
const HERMETIC_TMP_STATE = Symbol.for('podium.test.hermeticTmpState')
const withState = globalThis as typeof globalThis & { [HERMETIC_TMP_STATE]?: HermeticTmpState }
// Initialised only on the FIRST evaluation in this process, which is the only moment
// tmpdir() still reports the host root rather than a container this module installed.
if (!withState[HERMETIC_TMP_STATE]) {
  // DECISION [POD-553] (agreed with POD-527): ambient PODIUM_STATE_DIR at process start is
  // treated as replaceable, not as a suite override. Seed assignedStateDir with whatever the
  // parent shell / parent vitest hermetic setup exported so the first mint replaces it.
  // SP-b85a wants tests insulated from ambient instance targeting; an inherited state root is
  // ambient, not a deliberate suite choice. The escape hatch that remains is a suite setting
  // its own PODIUM_STATE_DIR from inside the file (beforeAll / top-level after this module
  // ran) — that value is not ours, so later mints leave it alone
  // (lifecycle.integration.bun.test.ts). Do not re-conservatise to "never replace a pre-set
  // value": that silently shared a parent vitest root across every file of a child bun test.
  withState[HERMETIC_TMP_STATE] = {
    containers: [],
    hostTmpdir: tmpdir(),
    assignedStateDir: process.env.PODIUM_STATE_DIR,
  }
}
const tmpState = withState[HERMETIC_TMP_STATE]

const removeDir = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort; the OS reaps /tmp eventually
  }
}
const removeAll = () => {
  for (const dir of tmpState.containers.splice(0)) removeDir(dir)
  tmpState.activeContainer = undefined
}
// Register exit handlers once per process — re-evaluating this module must not stack them
// (a multi-file reused runner would otherwise hit MaxListenersExceededWarning).
if (!tmpState.exitHandlersInstalled) {
  tmpState.exitHandlersInstalled = true
  process.on('exit', removeAll)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      removeAll()
      process.exit(1)
    })
  }
}

/**
 * Mint a fresh tmp container and (when appropriate) PODIUM_STATE_DIR for the current test
 * file. Safe to call more than once in one process — anchors containers to the host tmp root
 * (not the previous file's TMPDIR), and only replaces PODIUM_STATE_DIR when it is unset or
 * still the value this module last assigned (a suite that set its own keeps it).
 */
export function mintHermeticFileScope(): void {
  // Anchor to the host root the process started with, not `tmpdir()` / TMPDIR — otherwise
  // file 2's container nests inside file 1's and vanishes when file 1's is released.
  const containerDir = mkdtempSync(join(tmpState.hostTmpdir, 'podium-test-run-'))
  tmpState.containers.push(containerDir)
  tmpState.activeContainer = containerDir
  // Publish the pre-containment tmpdir BEFORE overriding TMPDIR. The e2e harness
  // (tests/e2e/harness-env.ts) must anchor its per-port dirs to the HOST tmp root
  // rather than this per-file container — see harnessTmpRoot() for why (path
  // determinism across processes + abduco's sun_path budget). [spec:SP-0be7]
  process.env.PODIUM_TEST_HOST_TMPDIR = tmpState.hostTmpdir
  process.env.TMPDIR = containerDir

  // Remint when unset OR when the value is still one this module assigned (including the
  // ambient value seeded at process start — see DECISION above). A suite that set its own
  // PODIUM_STATE_DIR after we ran is left alone.
  const inheritedStateDir = process.env.PODIUM_STATE_DIR
  if (!inheritedStateDir || inheritedStateDir === tmpState.assignedStateDir) {
    // Lives inside the container above, so releasing the container removes it too.
    tmpState.assignedStateDir = mkdtempSync(join(containerDir, 'podium-test-'))
    process.env.PODIUM_STATE_DIR = tmpState.assignedStateDir
  }

  assertHermeticStateDir()
}

/**
 * Bun-only: remint when the runner advances to a different test file.
 *
 * A bun preload evaluates once per process; `beforeEach` still runs for every test across
 * every file. `Bun.main` tracks the file currently under test, so a change is a file
 * boundary. No-op when the file has not changed (same-file beforeEach). [POD-553]
 *
 * Previous containers are NOT released here. Bun loads each file's top-level after the
 * previous file's tests finish but before this hook runs, so a suite that `mkdtemp`s at
 * module scope (lifecycle.integration.bun.test.ts) may land dirs inside the previous
 * TMPDIR; releasing that container would delete them. Exit handlers sweep everything.
 */
export function ensureHermeticFileScopeForBun(fileKey: string | undefined): void {
  if (fileKey !== undefined && fileKey === tmpState.activeFileKey) return
  // First file of the process: the preload already minted a container. Bind the file key
  // and keep it — reminting would only thrash TMPDIR before any test has run.
  if (tmpState.activeFileKey === undefined && tmpState.activeContainer) {
    tmpState.activeFileKey = fileKey
    assertHermeticStateDir()
    return
  }
  mintHermeticFileScope()
  tmpState.activeFileKey = fileKey
}

/**
 * Drop the active test file's tmp container only — not every container this process has
 * minted. A reused vitest runner (POD-527) may still hold prior files' containers until their
 * own afterAll released them; this must not sweep those. Reads `activeContainer` from the
 * process registry (set by the latest mint for the file currently running). Idempotent and
 * safe to call twice. Exit handlers remain the backstop if a caller never invokes this.
 */
export function releaseHermeticTmpContainer(): void {
  const containerDir = tmpState.activeContainer
  if (!containerDir) return
  const index = tmpState.containers.indexOf(containerDir)
  if (index !== -1) tmpState.containers.splice(index, 1)
  if (process.env.TMPDIR === containerDir) {
    process.env.TMPDIR = tmpState.hostTmpdir
  }
  if (tmpState.assignedStateDir?.startsWith(containerDir + sep) || tmpState.assignedStateDir === containerDir) {
    if (process.env.PODIUM_STATE_DIR === tmpState.assignedStateDir) {
      delete process.env.PODIUM_STATE_DIR
    }
    tmpState.assignedStateDir = undefined
  }
  tmpState.activeContainer = undefined
  removeDir(containerDir)
}

// First mint: covers vitest setupFiles re-import (one evaluation per file) and the initial
// bun preload evaluation (before any test file's beforeEach). Bun multi-file runs remint via
// ensureHermeticFileScopeForBun from test-hermetic-bun-hooks.ts.
mintHermeticFileScope()
