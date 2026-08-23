import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { assertHermeticStateDir } from '../../../test-hermetic-state-guard'
import { hermeticChildEnv } from '../../../test-hermetic-env'

/**
 * Bun-runtime twin of packages/runtime/src/hermetic-env.test.ts: proves the hermetic harness
 * (test-hermetic-env.ts, wired as bunfig.toml `[test].preload`) ran for the `bun test` scope
 * too, so `bun run test:bun` from inside a live session can't reach the live instance.
 * [spec:SP-b85a] (POD-555)
 *
 * Cross-file isolation (two files, one bun process, distinct roots) is covered by
 * scripts/hermetic-bun-per-file.test.ts [POD-553] — a single file cannot observe that bug.
 */
describe('hermetic bun test env', () => {
  it('preload scrubbed the ambient Podium agent-session env', () => {
    expect(process.env.PODIUM_AGENT_RELAY).toBeUndefined()
    expect(process.env.PODIUM_ISSUE_RELAY).toBeUndefined()
    expect(process.env.PODIUM_SESSION_ID).toBeUndefined()
    expect(process.env.PODIUM_PORT).toBeUndefined()
    expect(process.env.PODIUM_NO_RELAY).toBe('1')
    expect(process.env.PODIUM_STATE_DIR).toBeTruthy()
    // State root lives inside this file's tmp container (per-file mint layout).
    expect(process.env.TMPDIR).toBeTruthy()
    expect(process.env.PODIUM_STATE_DIR!.startsWith(`${process.env.TMPDIR}/`)).toBe(true)
    // The codex hook ingest locator is scrubbed too (POD-565 coordination) so a codex
    // session's tests can't POST to the live daemon's hook ingest.
    expect(process.env.PODIUM_CODEX_HOOK_URL).toBeUndefined()
    const liveStateDir = resolve(join(homedir(), '.podium'))
    const pathEntries = (process.env.PATH ?? '').split(delimiter).map((entry) => resolve(entry))
    expect(
      pathEntries.some(
        (entry) => entry === liveStateDir || entry.startsWith(`${liveStateDir}${sep}`),
      ),
    ).toBe(false)
    expect(() => assertHermeticStateDir({}, liveStateDir)).toThrow(/PODIUM_STATE_DIR is required/)
  })
})

describe('hermetic bun child env', () => {
  it('passes the preload scrubs to a real child process', () => {
    const env = hermeticChildEnv({
      PODIUM_TEST_CHILD_ENV_SENTINEL: 'hermetic-child-env',
    })
    const probe = [
      'process.stdout.write(JSON.stringify({',
      '  agentRelay: process.env.PODIUM_AGENT_RELAY ?? null,',
      '  sessionId: process.env.PODIUM_SESSION_ID ?? null,',
      '  port: process.env.PODIUM_PORT ?? null,',
      '  noRelay: process.env.PODIUM_NO_RELAY ?? null,',
      '  stateDir: process.env.PODIUM_STATE_DIR ?? null,',
      '  tmpDir: process.env.TMPDIR ?? null,',
      '  path: process.env.PATH ?? null,',
      '  sentinel: process.env.PODIUM_TEST_CHILD_ENV_SENTINEL ?? null,',
      '}))',
    ].join('\n')
    const observed = JSON.parse(
      execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env }),
    ) as Record<string, string | null>

    expect(observed).toEqual({
      sentinel: 'hermetic-child-env',
      agentRelay: null,
      sessionId: null,
      port: null,
      noRelay: '1',
      stateDir: env.PODIUM_STATE_DIR,
      tmpDir: env.TMPDIR,
      path: env.PATH,
    })
  })
})
