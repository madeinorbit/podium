import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PairingManager } from './hub/pairing'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { wireDaemonSocket } from './wsServer'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Minimal `ws` socket double: records sent frames, lets tests drive `message`/`close`. */
function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return {
    sent,
    readyState: 1,
    send: (s: string) => sent.push(s),
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      handlers[ev] = cb
    },
    emit: (ev: string, ...a: unknown[]) => handlers[ev]?.(...a),
  }
}

describe('daemon socket auth', () => {
  it('ignores a pre-auth non-handshake frame, then attaches on a valid hello', () => {
    const store = new SessionStore(':memory:')
    store.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box',
      tokenHash: sha256('tok'),
    })
    const reg = new SessionRegistry(store)
    const attach = vi.spyOn(reg, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)

    // First frame is junk (not a handshake) → ignored, no attach.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', sessionId: 's', data: '' })))
    expect(attach).not.toHaveBeenCalled()

    // A valid hello whose token is in the store → attach + helloOk.
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' }),
      ),
    )
    expect(attach).toHaveBeenCalledWith('m1', expect.any(Function))
    expect(ws.sent.some((s) => s.includes('helloOk'))).toBe(true)
  })

  it('the pre-registered local machine authenticates via the normal hello + routes control', () => {
    const store = new SessionStore(':memory:')
    // The local machine is a normal registered machine: the server provisioned it at
    // startup (ensureLocalMachine) with a server-owned credential. Its same-host daemon
    // then authenticates through the same hello path as any remote — no special case.
    store.upsertMachine({
      id: 'local',
      name: 'thishost',
      hostname: 'thishost',
      tokenHash: sha256('sekret'),
    })
    const reg = new SessionRegistry(store)
    const attach = vi.spyOn(reg, 'attachDaemon')
    const onMsg = vi.spyOn(reg, 'onDaemonMessageFrom')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'hello',
          machineId: 'local',
          token: 'sekret',
          hostname: 'thishost',
        }),
      ),
    )
    expect(attach).toHaveBeenCalledWith('local', expect.any(Function))
    expect(ws.sent.some((s) => s.includes('helloOk'))).toBe(true)

    // A subsequent (post-auth) frame routes through onDaemonMessageFrom under that id.
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'bind',
          sessionId: 's1',
          cmd: 'claude',
          cwd: '/tmp',
          agentKind: 'claude-code',
          geometry: { cols: 80, rows: 24 },
        }),
      ),
    )
    expect(onMsg).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({ type: 'bind', sessionId: 's1' }),
    )
  })

  it('rejects an unknown hello with helloRejected and does not attach', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const attach = vi.spyOn(reg, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'hello', machineId: 'ghost', token: 'nope', hostname: 'box' }),
      ),
    )
    expect(attach).not.toHaveBeenCalled()
    expect(ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('a pair frame redeems a code, replies paired with a token, then helloOk + attach', () => {
    const store = new SessionStore(':memory:')
    // Pairing is a hub-role capability, injected the way server assembly does it.
    const reg = new SessionRegistry(store, undefined, { pairing: new PairingManager() })
    const attach = vi.spyOn(reg, 'attachDaemon')
    const code = reg.mintPairingCode()
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'pair',
          code,
          machineId: 'mNew',
          hostname: 'newbox',
          name: 'newbox',
        }),
      ),
    )
    const paired = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'paired')
    expect(paired).toBeDefined()
    expect(typeof paired.token).toBe('string')
    expect(paired.token.length).toBeGreaterThan(0)
    expect(ws.sent.some((s) => s.includes('helloOk'))).toBe(true)
    expect(attach).toHaveBeenCalledWith('mNew', expect.any(Function))
  })

  it('detaches the machine on close', () => {
    const store = new SessionStore(':memory:')
    store.upsertMachine({ id: 'm1', name: 'h', hostname: 'h', tokenHash: sha256('tok') })
    const reg = new SessionRegistry(store)
    const detach = vi.spyOn(reg, 'detachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'h' })),
    )
    ws.emit('close')
    // Close detaches against THIS socket's send fn, so a superseded socket's late
    // close can't evict a daemon that has already reconnected.
    expect(detach).toHaveBeenCalledWith('m1', expect.any(Function))
  })

  it('does not detach when the socket closes before it ever attached', () => {
    const store = new SessionStore(':memory:')
    store.upsertMachine({ id: 'm1', name: 'h', hostname: 'h', tokenHash: sha256('tok') })
    const reg = new SessionRegistry(store)
    const detach = vi.spyOn(reg, 'detachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    // A failed handshake (bad token) never attaches — closing must not detach the
    // machine, which may well have a healthy daemon on another socket.
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'hello', machineId: 'm1', token: 'wrong', hostname: 'h' }),
      ),
    )
    ws.emit('close')
    expect(detach).not.toHaveBeenCalled()
  })
})
