import { homedir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAgentRelay } from './config'

/**
 * Proves the hermetic test harness (test-hermetic-env.ts, wired as vitest `setupFiles`)
 * actually ran for this file — i.e. a suite launched from inside a live agent session is
 * insulated from the live instance. [spec:SP-b85a] (POD-555)
 */
describe('hermetic test env', () => {
  it('scrubs the ambient Podium agent-session env', () => {
    expect(process.env.PODIUM_AGENT_RELAY).toBeUndefined()
    expect(process.env.PODIUM_ISSUE_RELAY).toBeUndefined()
    expect(process.env.PODIUM_SESSION_ID).toBeUndefined()
    expect(process.env.PODIUM_PORT).toBeUndefined()
  })

  it('forces operator mode — resolveAgentRelay() reads undefined from the live env', () => {
    expect(process.env.PODIUM_NO_RELAY).toBe('1')
    expect(resolveAgentRelay()).toBeUndefined()
  })

  it('points state at a throwaway dir, never the live ~/.podium', () => {
    expect(process.env.PODIUM_STATE_DIR).toBeTruthy()
    expect(process.env.PODIUM_STATE_DIR).not.toMatch(/\.podium(\/|$)/)
  })

  it('removes the live ~/.podium tree from command lookup', () => {
    const liveStateDir = resolve(join(homedir(), '.podium'))
    const pathEntries = (process.env.PATH ?? '').split(delimiter).map((entry) => resolve(entry))
    expect(
      pathEntries.some((entry) => entry === liveStateDir || entry.startsWith(`${liveStateDir}${sep}`)),
    ).toBe(false)
  })
})
