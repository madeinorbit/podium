/**
 * Hermetic test environment [spec:SP-b85a].
 *
 * Runs before every test file — wired as vitest `setupFiles` (vitest.config.ts) and as a
 * `bun test` preload (bunfig.toml `[test].preload`), so BOTH runners get it. Its job: strip
 * the ambient Podium agent-session env so a suite launched from INSIDE a live agent session
 * cannot touch, or be hijacked by, the live instance.
 *
 * Why this is needed: an agent session carries PODIUM_AGENT_RELAY (+ PODIUM_SESSION_ID,
 * PODIUM_PORT) in its env, and stateDir() falls back to ~/.podium when PODIUM_STATE_DIR is
 * unset. Any test that reads process.env without overriding it would otherwise route through
 * the session relay, dial the live server on :18787, or open the live ~/.podium/podium.db —
 * i.e. "separate instances can't be tested; they conflict with the main instance" (POD-555).
 *
 * The scrub mirrors resolveAgentRelay()'s escape hatch:
 *  - drop the session-identity + instance-targeting vars, so nothing inherits them;
 *  - set PODIUM_NO_RELAY=1, so resolveAgentRelay() returns undefined (act as operator, not
 *    "this session") for any code that reads the live process.env;
 *  - point PODIUM_STATE_DIR at a per-file throwaway (setupFiles runs once per test file, in
 *    its own fork) so stateDir() never resolves to ~/.podium. A suite that sets its own
 *    PODIUM_STATE_DIR keeps it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ---- tmp-dir containment [spec:SP-0be7] (POD-518) -------------------------------------------
// INVARIANT: everything a test process (and any child it spawns) writes to "tmp" lands inside
// ONE per-process dir that is removed when the process exits. A full-suite run used to leak
// ~660 dirs / 84MB into /tmp per run (POD-518; /tmp hit 143k entries) because 181 mkdtemp
// sites across 44 test files had no cleanup — worst case a real ~/.codex/auth.json copied
// into a world-readable /tmp home for up to 30 days.
//
// Mechanism: create the container in the ORIGINAL tmpdir, then point TMPDIR at it. Verified
// (bun 1.x and node both) that os.tmpdir() re-reads TMPDIR at call time, so every subsequent
// os.tmpdir()/mkdtemp in this process is contained; child processes inherit process.env, so
// their tmp writes are contained too. Pool is forks (one process per test file), so the
// container is per-file. Cleanup: process 'exit' plus best-effort signal handlers — a
// SIGKILLed fork still leaks its one dir, but the prefix 'podium-test-run-' is safe to sweep.
const cleanupDirs: string[] = []
const removeAll = () => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort; the OS reaps /tmp eventually
    }
  }
}
const containerDir = mkdtempSync(join(tmpdir(), 'podium-test-run-'))
cleanupDirs.push(containerDir)
process.env.TMPDIR = containerDir
process.on('exit', removeAll)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    removeAll()
    process.exit(1)
  })
}

if (!process.env.PODIUM_STATE_DIR) {
  // One throwaway per test file (setupFiles/preload run once per fork). It lives inside the
  // container above, so the exit cleanup removes it too.
  process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-test-'))
}
