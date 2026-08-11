import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, getProcessContext, getSinks, resetLogging } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureProcessLogging, logFilePath } from './logging'

let dir: string

beforeEach(() => {
  resetLogging()
  dir = mkdtempSync(join(tmpdir(), 'podium-logging-'))
})

afterEach(() => {
  resetLogging()
  rmSync(dir, { recursive: true, force: true })
})

/** A hermetic env: never the ambient one, which may carry a real PODIUM_LOG. */
const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('configureProcessLogging', () => {
  describe('sink selection — exactly one sink owns the stream', () => {
    it('detached writes the rotating file and registers nothing else', () => {
      const handle = configureProcessLogging({ role: 'server', mode: 'detached', dir, env: env() })
      expect(handle.sink.name).toBe('file')
      expect(getSinks()).toHaveLength(1)
      expect(handle.destination).toBe(logFilePath('server', dir))
    })

    it('systemd writes NDJSON to stdout and registers no file sink', () => {
      // Under systemd journald owns retention; a file sink too would store
      // every record twice under two different retention policies.
      const handle = configureProcessLogging({ role: 'server', mode: 'systemd', dir, env: env() })
      expect(handle.sink.name).toBe('stdout')
      expect(getSinks()).toHaveLength(1)
      expect(existsSync(logFilePath('server', dir))).toBe(false)
    })

    it('foreground writes to the console — a dev run has a terminal, not a tail', () => {
      const handle = configureProcessLogging({ role: 'cli', mode: 'foreground', dir, env: env() })
      expect(handle.sink.name).toBe('console')
      expect(getSinks()).toHaveLength(1)
    })

    it('takes the mode from the environment when the caller does not pass one', () => {
      expect(
        configureProcessLogging({ role: 'server', dir, env: env({ NOTIFY_SOCKET: '/run/x' }) }).mode,
      ).toBe('systemd')
      expect(
        configureProcessLogging({ role: 'server', dir, env: env({ PODIUM_RUN_MODE: 'detached' }) })
          .mode,
      ).toBe('detached')
      expect(configureProcessLogging({ role: 'server', dir, env: env() }).mode).toBe('foreground')
    })
  })

  it('names the file after the role, so podium logs can find it per component', () => {
    for (const role of ['server', 'daemon', 'janitor']) {
      configureProcessLogging({ role, mode: 'detached', dir, env: env() })
      createLogger(`${role}:test`).info('up')
    }
    expect(readRecords(logFilePath('server', dir))[0]).toMatchObject({ role: 'server', msg: 'up' })
    expect(readRecords(logFilePath('daemon', dir))[0]).toMatchObject({ role: 'daemon' })
    expect(readRecords(logFilePath('janitor', dir))[0]).toMatchObject({ role: 'janitor' })
  })

  it('replaces the previous sink rather than stacking on it', () => {
    // The CLI configures as `cli` before it knows what it was asked to do, then
    // a `podium janitor` re-configures. Two live sinks would double every record.
    configureProcessLogging({ role: 'cli', mode: 'detached', dir, env: env() })
    configureProcessLogging({ role: 'janitor', mode: 'detached', dir, env: env() })
    createLogger('janitor:test').info('once')
    expect(getSinks()).toHaveLength(1)
    expect(readRecords(logFilePath('janitor', dir))).toHaveLength(1)
    expect(existsSync(logFilePath('cli', dir))).toBe(false)
  })

  describe('process context', () => {
    it('binds role, version and platform onto every record', () => {
      configureProcessLogging({
        role: 'daemon',
        mode: 'detached',
        dir,
        version: '1.2.3',
        env: env(),
      })
      createLogger('daemon:pty').warn('resize dropped', { sessionId: 's1' })
      expect(readRecords(logFilePath('daemon', dir))[0]).toMatchObject({
        level: 'warn',
        ns: 'daemon:pty',
        msg: 'resize dropped',
        sessionId: 's1',
        role: 'daemon',
        v: '1.2.3',
        platform: process.platform,
      })
    })

    it('takes the version from PODIUM_APP_VERSION, else reports dev', () => {
      configureProcessLogging({
        role: 'server',
        mode: 'detached',
        dir,
        env: env({ PODIUM_APP_VERSION: '0.9.9' }),
      })
      expect(getProcessContext().v).toBe('0.9.9')
      configureProcessLogging({ role: 'server', mode: 'detached', dir, env: env() })
      expect(getProcessContext().v).toBe('dev')
    })
  })

  describe('defaultLevel', () => {
    it('quietens a process that asked to be quiet', () => {
      configureProcessLogging({
        role: 'cli',
        mode: 'detached',
        dir,
        defaultLevel: 'warn',
        env: env(),
      })
      const log = createLogger('cli:test')
      log.info('routine')
      log.warn('a real problem')
      expect(readRecords(logFilePath('cli', dir)).map((r) => r.msg)).toEqual(['a real problem'])
    })

    it('never overrides an operator who set PODIUM_LOG_LEVEL', () => {
      // The whole point of raising verbosity is to see more; a boot-time
      // setLogLevel would beat the env var and silently do nothing.
      configureProcessLogging({
        role: 'cli',
        mode: 'detached',
        dir,
        defaultLevel: 'warn',
        env: env({ PODIUM_LOG_LEVEL: 'debug' }),
      })
      createLogger('cli:test').debug('asked for')
      expect(readRecords(logFilePath('cli', dir)).map((r) => r.msg)).toEqual(['asked for'])
    })

    it('never overrides an operator who set PODIUM_LOG', () => {
      configureProcessLogging({
        role: 'cli',
        mode: 'detached',
        dir,
        defaultLevel: 'warn',
        env: env({ PODIUM_LOG: 'cli:*=debug' }),
      })
      createLogger('cli:test').debug('asked for')
      expect(readRecords(logFilePath('cli', dir)).map((r) => r.msg)).toEqual(['asked for'])
    })
  })

  describe('the handle', () => {
    it('unregisters the sink on close, so later logging cannot reopen the file', async () => {
      const handle = configureProcessLogging({ role: 'server', mode: 'detached', dir, env: env() })
      await handle.close()
      expect(getSinks()).toHaveLength(0)
      createLogger('server:test').error('after close')
      expect(existsSync(logFilePath('server', dir))).toBe(false)
    })

    it('is safe to flush and close more than once', async () => {
      const handle = configureProcessLogging({ role: 'server', mode: 'detached', dir, env: env() })
      createLogger('server:test').info('x')
      await handle.flush()
      await handle.flush()
      await handle.close()
      await expect(handle.close()).resolves.toBeUndefined()
    })
  })
})
