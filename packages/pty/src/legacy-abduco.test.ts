import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAbducoBin } from './abduco-bin.js'
import { abducoAdoptionAdapter, createDurableProcess } from './durable-process.js'
import {
  noteUnadoptableAbducoSession,
  resetUnadoptableAbducoNotesForTests,
} from './legacy-abduco.js'

/**
 * POD-4986: running abduco sessions are ADOPTED, and nothing creates one. The
 * adoption adapter refuses every create verb; and where no abduco client can
 * be had to attach with, a found session is logged ONCE by label and left
 * alone — found by its socket file, never by connecting to the master.
 */
describe('abduco sessions after abduco stopped being a spawn backend', () => {
  let root = ''
  let server: Server | undefined
  let connections = 0
  let restoreSink: (() => void) | undefined
  const records: LogRecord[] = []
  const savedAbduco = process.env.PODIUM_ABDUCO

  beforeEach(() => {
    root = mkdtempSync('/tmp/pla-')
    resetUnadoptableAbducoNotesForTests()
    records.length = 0
    connections = 0
    restoreSink = addSink({ name: 'legacy-abduco-test', write: (r) => records.push(r) })
  })
  afterEach(async () => {
    restoreSink?.()
    if (savedAbduco === undefined) delete process.env.PODIUM_ABDUCO
    else process.env.PODIUM_ABDUCO = savedAbduco
    resolveAbducoBin({ fresh: true })
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
    rmSync(root, { recursive: true, force: true })
  })

  /** A live abduco-style master socket at `$HOME/.abduco/<label>@<host>`. */
  async function abducoMaster(label: string): Promise<NodeJS.ProcessEnv> {
    const home = join(root, 'h')
    mkdirSync(join(home, '.abduco'), { recursive: true })
    server = createServer(() => {
      connections += 1
    })
    const path = join(home, '.abduco', `${label}@${hostname()}`)
    await new Promise<void>((resolve) => server?.listen(path, resolve))
    return { HOME: home, PODIUM_HOST_SOCKET_DIR: join(root, 's') }
  }

  const warnings = (label: string): LogRecord[] =>
    records.filter((r) => r.level === 'warn' && JSON.stringify(r).includes(label))

  it('refuses every create verb: abduco sessions are adopted, never created', async () => {
    const adapter = abducoAdoptionAdapter()
    await expect(adapter.spawn({ label: 'x', cmd: 'sh', cols: 80, rows: 24 })).rejects.toThrow(
      /adopted, never created/,
    )
    await expect(adapter.spawnHeadless({ label: 'x', cmd: 'sh' })).rejects.toThrow(
      /adopted, never created/,
    )
    await expect(adapter.attachHeadless({ label: 'x' })).rejects.toThrow(/adopted, never created/)
    // Spawns always go to the host.
    expect(createDurableProcess().primary.kind).toBe('host')
  })

  it('without an abduco client: locate says "not found", logs the label once, never touches the master', async () => {
    const env = await abducoMaster('podium-legacy')
    // An explicit override that does not run FAILS abduco resolution (no fallback).
    process.env.PODIUM_ABDUCO = join(root, 'no-such-abduco')
    expect(resolveAbducoBin({ fresh: true })).toBeUndefined()
    const durable = createDurableProcess()
    expect(await durable.locate('podium-legacy', env)).toBeUndefined()
    expect(await durable.locate('podium-legacy', env)).toBeUndefined()
    const said = warnings('podium-legacy')
    expect(said).toHaveLength(1)
    expect(JSON.stringify(said[0])).toMatch(/not re-adopting it, and leaving its process running/)
    expect(connections).toBe(0)
  })

  it('says nothing for a label no abduco master holds', async () => {
    const env = await abducoMaster('podium-legacy')
    expect(await createDurableProcess().locate('podium-gone', env)).toBeUndefined()
    expect(warnings('podium-gone')).toHaveLength(0)
  })

  it('logs each label once for the daemon life', () => {
    noteUnadoptableAbducoSession('podium-a', '/x/a')
    noteUnadoptableAbducoSession('podium-a', '/x/a')
    noteUnadoptableAbducoSession('podium-b', '/x/b')
    expect(warnings('podium-a')).toHaveLength(1)
    expect(warnings('podium-b')).toHaveLength(1)
  })
})
