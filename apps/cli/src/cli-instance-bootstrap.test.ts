import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './cli'

vi.mock('@podium/runtime/logging', () => ({
  configureProcessLogging: vi.fn(() => {
    const stateDir = process.env.PODIUM_STATE_DIR
    if (!stateDir) throw new Error('test requires PODIUM_STATE_DIR')
    // Reproduce the packaged cold-install boundary: configuring detached logging
    // populated logs/ before channel dispatch reached its config write.
    mkdirSync(join(stateDir, 'logs'), { recursive: true })
    return {
      mode: 'detached',
      sink: { name: 'test', write: () => {} },
      destination: join(stateDir, 'logs', 'cli.ndjson'),
      flush: async () => {},
      close: async () => {},
    }
  }),
}))

const cleanup: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CLI instance bootstrap', () => {
  it('claims an absent named root before file logging and channel persistence', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'podium-cli-bootstrap-'))
    cleanup.push(parent)
    const stateDir = join(parent, 'blue')
    const priorArgv = process.argv
    const priorExitCode = process.exitCode
    const priorEnv = {
      PODIUM_ADOPT_STATE: process.env.PODIUM_ADOPT_STATE,
      PODIUM_APP_VERSION: process.env.PODIUM_APP_VERSION,
      PODIUM_INSTANCE: process.env.PODIUM_INSTANCE,
      PODIUM_RUN_MODE: process.env.PODIUM_RUN_MODE,
      PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
    }
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      process.exitCode = typeof code === 'number' ? code : Number(code)
      return undefined as never
    })

    try {
      expect(existsSync(stateDir)).toBe(false)
      process.argv = ['bun', 'podium', '--instance', 'blue', 'channel', 'edge']
      delete process.env.PODIUM_ADOPT_STATE
      process.env.PODIUM_APP_VERSION = '9.9.9'
      process.env.PODIUM_RUN_MODE = 'detached'
      process.env.PODIUM_STATE_DIR = stateDir
      process.exitCode = undefined

      await main(async () => {
        throw new Error('channel command must not load host modules')
      })

      expect(exit).not.toHaveBeenCalled()
      expect(existsSync(join(stateDir, 'logs'))).toBe(true)
      expect(JSON.parse(readFileSync(join(stateDir, 'instance.json'), 'utf8'))).toMatchObject({
        instanceId: 'blue',
      })
      expect(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))).toMatchObject({
        updateChannel: 'edge',
      })
    } finally {
      process.argv = priorArgv
      process.exitCode = priorExitCode
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
