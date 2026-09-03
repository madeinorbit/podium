import { beforeEach, describe, expect, it, vi } from 'vitest'

const childProcesses = vi.hoisted(() => vi.fn(() => ({ status: 0 })))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: childProcesses,
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}))

import { resetCursorCliCache } from './cursor/cli.js'
import { agentLaunchCommand } from './index.js'
import { resetOpencodeCliCache } from './opencode/cli.js'

describe('PTY launch command resolution', () => {
  beforeEach(() => {
    childProcesses.mockClear()
    resetCursorCliCache()
    resetOpencodeCliCache()
  })

  it('selects OpenCode without starting a version child', () => {
    expect(agentLaunchCommand('opencode', { cwd: '/work' }).cmd).toContain('.opencode/bin/opencode')
    expect(childProcesses).not.toHaveBeenCalled()
  })

  it('selects Cursor without starting a version child', () => {
    expect(agentLaunchCommand('cursor', { cwd: '/work' }).cmd).toContain('.local/bin/agent')
    expect(childProcesses).not.toHaveBeenCalled()
  })
})
