import { hasLegacyAbduco, legacyAbducoBin } from '../../../../packages/pty/src/legacy-abduco-fixture'
/**
 * THE COUNTER OVER REAL BACKENDS (POD-4888): a real podium-host whose writer
 * lease is stolen, a second real attachment that never held the lease, and a
 * real abduco master an older Podium started (adopted, never created —
 * POD-4986), each held by the daemon's Terminal on a session entry exactly as
 * `wireBridge` holds them.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import {
  attachHostAgent,
  createDurableProcess,
  type DurableAttachment,
  killAbducoSession,
  killHostSession,
  resolveHostBin,
  spawnHostAgent,
} from '@podium/process/durable'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../session/registry.js'
import { Terminal } from './terminal.js'

/** A Rust podium-host: $PODIUM_HOST_BIN, the release payload, or a checkout build. */
const hasHost = resolveHostBin() !== undefined
/** The abduco client adoption attaches with (vendored, built on first use). */
const hasAbducoClient = hasLegacyAbduco

const ENV_KEYS = [
  'PODIUM_STATE_DIR',
  'PODIUM_HOST_SOCKET_DIR',
  'PODIUM_NO_SCOPE',
  'ABDUCO_SOCKET_DIR',
]
const saved: Record<string, string | undefined> = {}
let root = ''
/** abduco's socket path must fit sun_path (107 bytes), so its root stays short. */
let sockRoot = ''
const hostLabels: string[] = []
const abducoLabels: string[] = []
const attachments: DurableAttachment[] = []

/**
 * A label no earlier attempt used: the lane retries a failed test once, and a
 * retry on the same label meets the previous attempt's host being killed,
 * whose closing connection would read as a lease loss and pass it by accident.
 */
let attempt = 0
const freshLabel = (prefix: string): string => `${prefix}${process.pid}-${++attempt}`

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

beforeAll(() => {
  if (!hasHost) return
  root = mkdtempSync(join(tmpdir(), 'podium-foreign-writes-'))
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 'sock')
  process.env.PODIUM_NO_SCOPE = '1'
  sockRoot = mkdtempSync('/tmp/fw-')
  process.env.ABDUCO_SOCKET_DIR = sockRoot
})

afterEach(async () => {
  for (const a of attachments.splice(0)) {
    try {
      a.dispose()
    } catch {
      // already gone
    }
  }
  for (const l of hostLabels.splice(0)) await killHostSession(l).catch(() => {})
  for (const l of abducoLabels.splice(0)) await killAbducoSession(l).catch(() => {})
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (root) rmSync(root, { recursive: true, force: true })
  if (sockRoot) rmSync(sockRoot, { recursive: true, force: true })
})

describe.skipIf(!hasHost)('the foreign-write counter over a real podium-host (POD-4888)', () => {
  it('podium-host: trustworthy while the lease is held; a steal counts and ends the trust', async () => {
    const label = freshLabel('podium-fw-host-')
    hostLabels.push(label)
    const held = await spawnHostAgent({
      label,
      cmd: 'sleep',
      args: ['30'],
      cols: 80,
      rows: 24,
      requireLease: true,
    })
    attachments.push(held)
    await held.ready
    const sessions = new SessionRegistry()
    const sessionId = asSessionId('fw-host')
    const owned = sessions.ensure(sessionId)
    const terminal = Terminal.attach(held, owned, { onFrame: () => {} })
    owned.replaceTerminal(terminal)
    expect(sessions.orderTrustworthy(sessionId)).toBe(true)

    // A real write through the real host: one count.
    const start = sessions.foreignWrites(sessionId)
    terminal.write(new TextEncoder().encode('x'))
    expect(sessions.foreignWrites(sessionId)).toBe(start + 1)

    // Another writer takes the lease: the holder hears LEASE_LOST.
    const taker = attachHostAgent({ label, fromSeq: 'tail' })
    attachments.push(taker)
    await taker.ready
    await taker.connection.steal()
    await waitFor(
      () => sessions.foreignWrites(sessionId) === start + 2,
      'the lease loss to be counted',
    )
    expect(sessions.orderTrustworthy(sessionId)).toBe(false)
  }, 30_000)

  it('a surface that never held the writer lease is never order-trustworthy', async () => {
    const label = freshLabel('podium-fw-reader-')
    hostLabels.push(label)
    const held = await spawnHostAgent({
      label,
      cmd: 'sleep',
      args: ['30'],
      cols: 80,
      rows: 24,
      requireLease: true,
    })
    attachments.push(held)
    await held.ready
    // A second attachment while the first holds the one writer lease: the
    // host admits it without the lease, so anyone else may be writing.
    const reader = attachHostAgent({ label, fromSeq: 'tail' })
    attachments.push(reader)
    await reader.ready
    expect(reader.holdsWriterLease?.()).toBe(false)
    const sessions = new SessionRegistry()
    const sessionId = asSessionId('fw-reader')
    const owned = sessions.ensure(sessionId)
    owned.replaceTerminal(Terminal.attach(reader, owned, { onFrame: () => {} }))
    expect(sessions.orderTrustworthy(sessionId)).toBe(false)
    // Still counted: the count is kept whatever the lease.
    const start = sessions.foreignWrites(sessionId)
    owned.terminal?.write(new TextEncoder().encode('y'))
    expect(sessions.foreignWrites(sessionId)).toBe(start + 1)
  }, 30_000)

  it.skipIf(!hasAbducoClient)(
    'an adopted abduco session: never order-trustworthy, since any `abduco -a` client writes unseen',
    async () => {
      const label = freshLabel('fw-')
      abducoLabels.push(label)
      // Created the way an older Podium did — the abduco binary itself; nothing
      // in Podium creates one any more.
      execFileSync(legacyAbducoBin as string, ['-n', label, 'sleep', '30'], {
        env: process.env,
        stdio: 'ignore',
      })
      const located = await createDurableProcess().locate(label, process.env, { waitMs: 5000 })
      expect(located?.adapter.kind).toBe('abduco')
      if (!located) throw new Error('the abduco session was not located')
      const { attachment } = await located.adapter.attach({
        label,
        socketPath: located.socketPath,
        lastKnownGeometry: { cols: 80, rows: 24 },
      })
      attachments.push(attachment)
      const sessions = new SessionRegistry()
      const sessionId = asSessionId('fw-abduco')
      const owned = sessions.ensure(sessionId)
      owned.replaceTerminal(Terminal.attach(attachment, owned, { onFrame: () => {} }))
      expect(sessions.orderTrustworthy(sessionId)).toBe(false)
      // Still counted: the count is kept whatever the backend.
      const start = sessions.foreignWrites(sessionId)
      owned.terminal?.write(new TextEncoder().encode('y'))
      expect(sessions.foreignWrites(sessionId)).toBe(start + 1)
    },
    30_000,
  )
})
