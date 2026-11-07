import { beforeEach, describe, expect, it, vi } from 'vitest'

const childProcesses = vi.hoisted(() => vi.fn(() => ({ status: 0 })))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: childProcesses,
}))

import { testHarnessContext } from './driver/testing/harness-context.js'
import { agentLaunchCommand } from './index.js'

/**
 * A PTY LAUNCH NEVER PROBES OR LOOKS UP A BINARY (POD-6536). The executable is
 * the session context's installation, which the inventory verified; building
 * the launch starts no child and reads no candidate path.
 */
describe('PTY launch command resolution', () => {
  beforeEach(() => {
    childProcesses.mockClear()
  })

  it.each(['opencode', 'cursor'] as const)('binds %s to the context without a child', (kind) => {
    const harnessContext = testHarnessContext({ kind, executable: `/opt/test/${kind}` })
    expect(agentLaunchCommand(kind, { cwd: '/work', harnessContext }).cmd).toBe(`/opt/test/${kind}`)
    expect(childProcesses).not.toHaveBeenCalled()
  })
})
