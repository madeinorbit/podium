import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurableProcess } from './durable-process.js'
import {
  legacyAbducoSocket,
  noteLegacyAbducoSession,
  resetLegacyAbducoNotesForTests,
} from './legacy-abduco.js'

/**
 * POD-4986: a session an abduco master still holds is not re-adopted (that
 * needs the abduco binary, which Podium no longer ships). The daemon logs it
 * ONCE by label and leaves the master alone — found by its socket file, never
 * by running abduco or connecting to the master.
 */
describe('abduco sessions after the abduco backend is gone', () => {
  let root = ''
  let server: Server | undefined
  let connections = 0
  let restoreSink: (() => void) | undefined
  const records: LogRecord[] = []

  beforeEach(() => {
    root = mkdtempSync('/tmp/pla-')
    resetLegacyAbducoNotesForTests()
    records.length = 0
    connections = 0
    restoreSink = addSink({ name: 'legacy-abduco-test', write: (r) => records.push(r) })
  })
  afterEach(async () => {
    restoreSink?.()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
    rmSync(root, { recursive: true, force: true })
  })

  /** A live abduco-style master socket at `$HOME/.abduco/<label>@<host>`. */
  async function abducoMaster(label: string): Promise<{ env: NodeJS.ProcessEnv; path: string }> {
    const home = join(root, 'h')
    mkdirSync(join(home, '.abduco'), { recursive: true })
    const path = join(home, '.abduco', `${label}@${hostname()}`)
    server = createServer(() => {
      connections += 1
    })
    await new Promise<void>((resolve) => server?.listen(path, resolve))
    return { env: { HOME: home, PODIUM_HOST_SOCKET_DIR: join(root, 's') }, path }
  }

  const warnings = (label: string): LogRecord[] =>
    records.filter((r) => r.level === 'warn' && JSON.stringify(r).includes(label))

  it('finds the socket by name, and only a socket', async () => {
    const { env, path } = await abducoMaster('podium-legacy')
    expect(legacyAbducoSocket('podium-legacy', env)).toBe(path)
    expect(legacyAbducoSocket('podium-other', env)).toBeUndefined()
    writeFileSync(join(env.HOME as string, '.abduco', `podium-file@${hostname()}`), '')
    expect(legacyAbducoSocket('podium-file', env)).toBeUndefined()
  })

  it('locate answers "not found", logs the label once, and never touches the master', async () => {
    const { env } = await abducoMaster('podium-legacy')
    const durable = createDurableProcess()
    expect(await durable.locate('podium-legacy', env)).toBeUndefined()
    expect(await durable.locate('podium-legacy', env)).toBeUndefined()
    expect(noteLegacyAbducoSession('podium-legacy', env)).toBe(true)
    const said = warnings('podium-legacy')
    expect(said).toHaveLength(1)
    expect(JSON.stringify(said[0])).toMatch(/not re-adopting it, and leaving its process running/)
    // Nothing connected to the master: it was left entirely alone.
    expect(connections).toBe(0)
  })

  it('says nothing for a label no abduco master holds', async () => {
    const { env } = await abducoMaster('podium-legacy')
    expect(await createDurableProcess().locate('podium-gone', env)).toBeUndefined()
    expect(noteLegacyAbducoSession('podium-gone', env)).toBe(false)
    expect(warnings('podium-gone')).toHaveLength(0)
  })
})
