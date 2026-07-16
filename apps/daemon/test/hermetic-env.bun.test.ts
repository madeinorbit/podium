import { describe, expect, it } from 'bun:test'

/**
 * Bun-runtime twin of packages/runtime/src/hermetic-env.test.ts: proves the hermetic harness
 * (test-hermetic-env.ts, wired as bunfig.toml `[test].preload`) ran for the `bun test` scope
 * too, so `bun run test:bun` from inside a live session can't reach the live instance.
 * [spec:SP-b85a] (POD-555)
 */
describe('hermetic bun test env', () => {
  it('preload scrubbed the ambient Podium agent-session env', () => {
    expect(process.env.PODIUM_AGENT_RELAY).toBeUndefined()
    expect(process.env.PODIUM_ISSUE_RELAY).toBeUndefined()
    expect(process.env.PODIUM_SESSION_ID).toBeUndefined()
    expect(process.env.PODIUM_PORT).toBeUndefined()
    expect(process.env.PODIUM_NO_RELAY).toBe('1')
    expect(process.env.PODIUM_STATE_DIR).toBeTruthy()
    // The codex hook ingest locator is scrubbed too (POD-565 coordination) so a codex
    // session's tests can't POST to the live daemon's hook ingest.
    expect(process.env.PODIUM_CODEX_HOOK_URL).toBeUndefined()
  })
})
