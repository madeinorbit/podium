import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}))

import { canScopeMaster } from './abduco.js'

describe.skipIf(process.platform !== 'linux')('async systemd scope capability', () => {
  let priorRuntimeDir: string | undefined
  let priorNoScope: string | undefined

  beforeAll(() => {
    priorRuntimeDir = process.env.XDG_RUNTIME_DIR
    priorNoScope = process.env.PODIUM_NO_SCOPE
    process.env.XDG_RUNTIME_DIR = '/run/user/podium-test'
    delete process.env.PODIUM_NO_SCOPE
  })

  afterAll(() => {
    if (priorRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = priorRuntimeDir
    if (priorNoScope === undefined) delete process.env.PODIUM_NO_SCOPE
    else process.env.PODIUM_NO_SCOPE = priorNoScope
  })

  it('coalesces callers without blocking the event loop', async () => {
    let finish!: (error: Error | null) => void
    execFile.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: object,
        callback: (error: Error | null) => void,
      ) => {
        finish = callback
        return undefined as never
      },
    )

    const first = canScopeMaster()
    const second = canScopeMaster()
    expect(execFile).toHaveBeenCalledTimes(1)

    finish(null)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })
})
