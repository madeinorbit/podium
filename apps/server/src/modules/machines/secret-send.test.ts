/**
 * A SECRET IS NEVER QUEUED (credential management §8; epic plan Task 5).
 *
 * `attachAccess` judges the daemon connected when a launch is resolved. The
 * frame goes out a little later, after the row is written. If the socket went
 * away meanwhile, or was replaced by an older daemon or a plain link, the
 * frame must not be parked in the offline queue for whatever connects next:
 * `toMachine` refuses it at the send.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { CAP_CREDENTIAL_IDENTITY_GUARD, CAP_SESSION_ACCESS } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, test } from 'vitest'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'
import type { Send } from '../sessions/session'
import { isRefusedSend, RefusedSendError } from './refused-send'
import { type MachinesDeps, MachinesService } from './service'

const MACHINE = asMachineId('machine-secret-send')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-queue-secret-0007'

function makeService(link: { kind: DaemonLinkKind | undefined }): MachinesService {
  return new MachinesService({
    instanceId: 'default',
    daemonLinkKind: () => link.kind,
    store: {
      machines: {
        getMachine: async () => ({ revokedAt: null }),
        addMachineComponent: () => false,
        setAvailability: async () => {},
        setPresenceSource: () => {},
        committed: { subscribe: () => () => {} },
      },
    } as unknown as MachinesDeps['store'],
    hostMachine: { id: asMachineId('host-under-test') },
  } satisfies MachinesDeps)
}

function spawnWith(kind: 'env' | 'home'): ControlMessage {
  return {
    type: 'spawn',
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000b7'),
    agentKind: 'claude-code',
    cwd: '/p',
    geometry: { cols: 80, rows: 24 },
    access: {
      credentialId: 'cred_00000000-0000-4000-8000-0000000000b7',
      delivery:
        kind === 'env'
          ? { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED }
          : { kind: 'home', homeId: 'h1' },
    },
  }
}

function recorder(): { send: Send<ControlMessage>; got: ControlMessage[] } {
  const got: ControlMessage[] = []
  return { send: (m) => got.push(m), got }
}

describe('toMachine with a frame that carries a secret', () => {
  test('goes to a capable daemon on a safe link', async () => {
    const svc = makeService({ kind: 'local' })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [CAP_SESSION_ACCESS])
    svc.toMachine(MACHINE, spawnWith('env'))
    expect(JSON.stringify(daemon.got)).toContain(PLANTED)
  })

  test('is refused, not queued, when no daemon is connected', async () => {
    const link: { kind: DaemonLinkKind | undefined } = { kind: undefined }
    const svc = makeService(link)
    expect(() => svc.toMachine(MACHINE, spawnWith('env'))).toThrow('no daemon is connected')
    // A daemon that connects afterwards receives nothing from the queue.
    link.kind = 'local'
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [CAP_SESSION_ACCESS])
    await svc.flushQueued(MACHINE)
    expect(daemon.got).toEqual([])
  })

  test('is refused for an older daemon and for a plain link', async () => {
    const older = makeService({ kind: 'encrypted' })
    await older.attach(MACHINE, recorder().send, [])
    expect(() => older.toMachine(MACHINE, spawnWith('env'))).toThrow('too old')
    const plain = makeService({ kind: 'plain' })
    await plain.attach(MACHINE, recorder().send, [CAP_SESSION_ACCESS])
    expect(() => plain.toMachine(MACHINE, spawnWith('env'))).toThrow('not encrypted')
  })

  test('a home delivery holds no secret and is not held back', async () => {
    const svc = makeService({ kind: undefined })
    expect(() => svc.toMachine(MACHINE, spawnWith('home'))).not.toThrow()
  })
})

/**
 * THE VAULT KEY IS NEVER QUEUED EITHER (credential management §7; POD-6906 S3).
 * A server-transfer promote frame carries the vault's data key. Parked in the
 * offline queue, it would reach whatever daemon attaches next, after the transfer
 * timed out as uncertain or was aborted, and ahead of the abort queued behind it.
 * The first test is POD-6906's repro, inverted.
 */
describe('toMachine with a promote frame that carries the vault key', () => {
  /** Obviously fake: 32 bytes of 7, base64. */
  const DATA_KEY = Buffer.alloc(32, 7).toString('base64')

  function promote(vaultDataKey: string | null): ControlMessage {
    return {
      type: 'serverTransferPromoteRequest',
      requestId: 'rpc-transfer-1',
      transferId: '00000000-0000-4000-8000-0000000000c1',
      manifestDigest: 'b'.repeat(64),
      publicUrl: 'https://podium.example',
      bindHost: '127.0.0.1',
      port: 18787,
      targetMode: 'server',
      idempotencyKey: '00000000-0000-4000-8000-0000000000c1',
      vaultDataKey,
      ...(vaultDataKey === null ? {} : { vaultCheck: 'a'.repeat(64) }),
    }
  }

  test('is refused, not queued, when no daemon is connected; a later attach gets no key', async () => {
    const link: { kind: DaemonLinkKind | undefined } = { kind: undefined }
    const svc = makeService(link)
    let refusal: unknown
    try {
      svc.toMachine(MACHINE, promote(DATA_KEY))
    } catch (error) {
      refusal = error
    }
    expect(isRefusedSend(refusal)).toBe(true)
    expect(String(refusal)).toContain('no daemon is connected')
    expect(String(refusal)).not.toContain(DATA_KEY)
    link.kind = 'encrypted'
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [])
    await svc.flushQueued(MACHINE)
    expect(daemon.got).toEqual([])
  })

  test('is refused over a link the server judged plain', async () => {
    const svc = makeService({ kind: 'plain' })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [])
    expect(() => svc.toMachine(MACHINE, promote(DATA_KEY))).toThrow(RefusedSendError)
    expect(() => svc.toMachine(MACHINE, promote(DATA_KEY))).toThrow('not encrypted')
    expect(JSON.stringify(daemon.got)).not.toContain(DATA_KEY)
  })

  test('goes to the attached daemon on a safe link', async () => {
    const svc = makeService({ kind: 'encrypted' })
    const daemon = recorder()
    // No session-access capability: the transfer's own preflight judged the target.
    await svc.attach(MACHINE, daemon.send, [])
    svc.toMachine(MACHINE, promote(DATA_KEY))
    expect(JSON.stringify(daemon.got)).toContain(DATA_KEY)
  })

  test('a promote without a key is not queued either, but a plain link may carry it', async () => {
    // Offline: a parked promote would commit after the transfer gave up on it.
    const offline = makeService({ kind: undefined })
    expect(() => offline.toMachine(MACHINE, promote(null))).toThrow(RefusedSendError)
    // It holds no secret, so the plain-link rule is the key's alone (canary for the rule above).
    const plain = makeService({ kind: 'plain' })
    const daemon = recorder()
    await plain.attach(MACHINE, daemon.send, [])
    plain.toMachine(MACHINE, promote(null))
    expect(daemon.got.map((m) => m.type)).toContain('serverTransferPromoteRequest')
  })
})

/**
 * A LOGIN FILE CROSSES ONLY A SAFE LINK, AND IS NEVER QUEUED (credential
 * management §8; POD-6906 S2). The install carries a harness's login file; the
 * export asks the daemon to send one back over the same link. The first test is
 * POD-6906's repro (a capable daemon on a plain link was sent the bundle),
 * inverted.
 */
describe('toMachine with a frame that moves a login file', () => {
  /** Obviously fake login file. */
  const LOGIN_FILE = Buffer.from('{"tokens":{"refresh_token":"FAKE-planted-login-0007"}}').toString(
    'base64',
  )

  function install(propagation: boolean): ControlMessage {
    return {
      type: 'credentialInstallRequest',
      requestId: 'rpc-cred-install-1',
      bundles: [{ kind: 'codex', contentBase64: LOGIN_FILE }],
      ...(propagation ? { propagation: true, expectedFingerprint: 'fp-1' } : {}),
    }
  }

  function exportRequest(propagation: boolean): ControlMessage {
    return {
      type: 'credentialExportRequest',
      requestId: 'rpc-cred-export-1',
      kinds: ['codex'],
      ...(propagation ? { propagation: true, expectedFingerprint: 'fp-1' } : {}),
    }
  }

  const caps = [CAP_SESSION_ACCESS, CAP_CREDENTIAL_IDENTITY_GUARD]

  test('an install is refused over a plain link, propagation or the legacy copy', async () => {
    const svc = makeService({ kind: 'plain' })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, caps)
    for (const propagation of [true, false]) {
      let refusal: unknown
      try {
        svc.toMachine(MACHINE, install(propagation))
      } catch (error) {
        refusal = error
      }
      expect(isRefusedSend(refusal)).toBe(true)
      expect(String(refusal)).toContain('not encrypted')
      expect(String(refusal)).not.toContain(LOGIN_FILE)
    }
    expect(JSON.stringify(daemon.got)).not.toContain(LOGIN_FILE)
    expect(daemon.got.map((m) => m.type)).not.toContain('credentialInstallRequest')
  })

  test('an export request is refused over a plain link, so no login file is sent back', async () => {
    const svc = makeService({ kind: 'plain' })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, caps)
    for (const propagation of [true, false]) {
      expect(() => svc.toMachine(MACHINE, exportRequest(propagation))).toThrow(RefusedSendError)
    }
    expect(daemon.got.map((m) => m.type)).not.toContain('credentialExportRequest')
  })

  test('a link the server has not classified is refused too', async () => {
    const svc = makeService({ kind: undefined })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, caps)
    expect(() => svc.toMachine(MACHINE, install(false))).toThrow('cannot tell')
    expect(() => svc.toMachine(MACHINE, exportRequest(false))).toThrow('cannot tell')
    expect(daemon.got).toEqual([])
  })

  test('neither is queued for an offline machine; a later attach gets nothing', async () => {
    const link: { kind: DaemonLinkKind | undefined } = { kind: undefined }
    const svc = makeService(link)
    // The legacy pairing copy carries no propagation flag and is held back all the same.
    expect(() => svc.toMachine(MACHINE, install(false))).toThrow('no daemon is connected')
    expect(() => svc.toMachine(MACHINE, exportRequest(false))).toThrow('no daemon is connected')
    link.kind = 'local'
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, caps)
    await svc.flushQueued(MACHINE)
    expect(daemon.got).toEqual([])
  })

  test('both go to the attached daemon over a local, encrypted or trusted link', async () => {
    for (const kind of ['local', 'encrypted', 'trusted'] as const) {
      const svc = makeService({ kind })
      const daemon = recorder()
      await svc.attach(MACHINE, daemon.send, caps)
      svc.toMachine(MACHINE, exportRequest(true))
      svc.toMachine(MACHINE, install(true))
      expect(daemon.got.map((m) => m.type)).toEqual([
        'credentialExportRequest',
        'credentialInstallRequest',
      ])
      expect(JSON.stringify(daemon.got)).toContain(LOGIN_FILE)
    }
  })
})
