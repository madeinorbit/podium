import { asMachineId, asSessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { memoryMarkers, SessionAccessStore } from './control/access'
import type { DaemonContext } from './control/context'
import { controlFrameByteLength, createFrameGuard, MAX_CONTROL_FRAME_BYTES } from './frame-guards'
import { attachTestTerminal, testSessions } from './session/testing.js'

const context = (): DaemonContext =>
  ({
    agentRelayHub: { onResult: vi.fn() },
    bindingStore: { isQuarantined: vi.fn(() => false), retainsHandoffHistory: vi.fn(() => false) },
    sessions: testSessions(),
    send: vi.fn(),
    access: new SessionAccessStore({ markers: memoryMarkers() }),
  }) as unknown as DaemonContext

describe('daemon frame guards', () => {
  it('measures every ws RawData representation without stringifying it', () => {
    expect(controlFrameByteLength(Buffer.from('hello'))).toBe(5)
    expect(controlFrameByteLength([Buffer.from('he'), Buffer.from('llo')])).toBe(5)
    expect(controlFrameByteLength(new Uint8Array([1, 2, 3]).buffer)).toBe(3)
  })

  it('drops and reports an oversized frame before parsing', () => {
    const warn = vi.fn()
    const guard = createFrameGuard(context(), { warn })
    guard.receive(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1))
    expect(warn).toHaveBeenCalledWith(
      'dropping an oversized control frame',
      expect.objectContaining({ maxBytes: MAX_CONTROL_FRAME_BYTES }),
    )
  })

  /**
   * POD-4524 — the older-peer rule for the new `closeClientTerminal` frame. A
   * daemon running a build that never saw the frame parses it exactly the way
   * this guard parses any unknown `type` literal: the zod union rejects it,
   * the frame is dropped with a throttled warn, nothing is answered (no
   * requestId rides an uncorrelated command), and the connection keeps
   * dispatching afterwards. Degrades, never breaks.
   */
  it('drops a frame type it has never seen and keeps dispatching', () => {
    const onResult = vi.fn()
    const ctx = context()
    ctx.agentRelayHub.onResult = onResult
    const warn = vi.fn()
    const guard = createFrameGuard(ctx, { warn })

    guard.receive(
      Buffer.from(JSON.stringify({ type: 'futureFrameFromANewerBuild', sessionId: 's1' })),
    )
    const valid: ControlMessage = {
      type: 'agentRelayResult',
      requestId: 'req-1',
      ok: true,
      result: null,
    }
    guard.receive(Buffer.from(JSON.stringify(valid)))

    expect(warn).toHaveBeenCalledWith(
      'dropped a malformed control frame',
      expect.objectContaining({ direction: 'inbound' }),
    )
    expect(ctx.send).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith(valid)
  })

  it('tolerates the benign malformed reattach frame and keeps dispatching', () => {
    const onResult = vi.fn()
    const ctx = context()
    ctx.agentRelayHub.onResult = onResult
    const warn = vi.fn()
    let at = 1_000
    const guard = createFrameGuard(ctx, { warn, now: () => at })

    guard.receive(Buffer.from('{not-json'))
    at += 10
    guard.receive(Buffer.from('{still-not-json'))
    const valid: ControlMessage = {
      type: 'agentRelayResult',
      requestId: 'req-1',
      ok: true,
      result: null,
    }
    guard.receive(Buffer.from(JSON.stringify(valid)))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(valid)
  })

  /**
   * POD-2223 — the whole point of the arm is that it is REACHED, not that the function
   * in isolation returns the right object. This drives the real receive path: an approval
   * exec request whose op this build's schema rejects must leave the guard with a reply
   * on the wire, not just a throttled warn in the journal.
   */
  it('answers an approval exec request whose op it cannot parse, then drops it', () => {
    const ctx = context()
    const warn = vi.fn()
    const guard = createFrameGuard(ctx, { warn })

    guard.receive(
      Buffer.from(
        JSON.stringify({
          type: 'approvalExecRequest',
          requestId: 'apr_99',
          op: { kind: 'channel', target: 'a-channel-no-build-has-ever-shipped' },
        }),
      ),
    )

    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approvalExecResult',
        requestId: 'apr_99',
        ok: false,
        exitCode: null,
      }),
    )
    // The frame is still dropped — answering is not accepting.
    expect(warn).toHaveBeenCalledWith(
      'dropped a malformed control frame',
      expect.objectContaining({ direction: 'inbound' }),
    )
  })

  it('contains outbound encoding/socket throws', () => {
    const warn = vi.fn()
    const guard = createFrameGuard(context(), { warn })
    const send = vi.fn(() => {
      throw new Error('closing')
    })
    expect(
      guard.send({ readyState: 1, send } as never, {
        type: 'inventoryReport',
        machineId: asMachineId('machine-1'),
        inventory: { os: 'linux', arch: 'x64', agents: [], tools: [] },
      }),
    ).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      'dropped a malformed control frame',
      expect.objectContaining({ direction: 'outbound', err: expect.any(Error) }),
    )
  })

  it('reports a non-open socket without attempting send', () => {
    const guard = createFrameGuard(context())
    const send = vi.fn()

    expect(
      guard.send({ readyState: 0, send } as never, {
        type: 'inventoryReport',
        machineId: asMachineId('machine-1'),
        inventory: { os: 'linux', arch: 'x64', agents: [], tools: [] },
      }),
    ).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

it('isolates a quarantined session from unrelated control frames and binary input', () => {
  const ctx = context()
  ctx.bindingStore.isQuarantined = (id) => id === 'quarantined'
  const write = vi.fn()
  attachTestTerminal(ctx, asSessionId('good'), {
    pid: 1,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: write,
    resize: () => {},
    dispose: () => {},
  } as never)
  const guard = createFrameGuard(ctx)
  // A kill for the unconfirmed binding must never reach the process handler.
  guard.receive(Buffer.from(JSON.stringify({ type: 'kill', sessionId: 'quarantined' })))
  guard.receiveBinaryInput(
    { v: 1, type: 'ptyInput', sessionId: asSessionId('quarantined'), inputOrigin: 'human' },
    Buffer.from('x'),
  )
  const reply = { type: 'agentRelayResult', requestId: 'unrelated', ok: true, result: null }
  guard.receive(Buffer.from(JSON.stringify(reply)))
  expect(ctx.agentRelayHub.onResult).toHaveBeenCalledWith(reply)
  expect(write).not.toHaveBeenCalled()
  guard.receiveBinaryInput(
    { v: 1, type: 'ptyInput', sessionId: asSessionId('good'), inputOrigin: 'human' },
    Buffer.from('y'),
  )
  expect(write).toHaveBeenCalledWith(Buffer.from('y'))
})

it('lets only a return handoff import reach the claim gate for handoff history (POD-7534)', async () => {
  const ctx = context()
  ctx.bindingStore.isQuarantined = (id) => id === 'history' || id === 'unresolved'
  ctx.bindingStore.retainsHandoffHistory = (id) => id === 'history'
  const guard = createFrameGuard(ctx)
  const chunk = (sessionId: string) =>
    Buffer.from(
      JSON.stringify({
        type: 'handoffImportChunk',
        requestId: sessionId,
        sessionId,
        offset: 0,
        data: '',
      }),
    )
  guard.receive(chunk('unresolved'))
  guard.receive(Buffer.from(JSON.stringify({ type: 'kill', sessionId: 'history' })))
  guard.receive(chunk('history'))
  await vi.waitFor(() =>
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'handoffImportChunkResult', requestId: 'history' }),
    ),
  )
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'unresolved' }))
})

/**
 * NEVER LOGGED (credential management §8): a frame of a type that can carry a
 * session's credential is reported by its type and the paths that failed, never
 * by the parse error, whatever field broke. Epic plan Task 5.
 */
describe('frames that can carry a credential', () => {
  /** Obviously fake. */
  const PLANTED = 'sk-FAKE-planted-frame-secret-0009'
  const brokenSpawn = {
    type: 'spawn',
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/p',
    geometry: { cols: 'wide', rows: 24 },
    access: {
      credentialId: 'cred_00000000-0000-4000-8000-000000000009',
      // An unknown delivery kind: the parse error would quote the object.
      delivery: { kind: PLANTED, variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
    },
  }

  it('a malformed spawn is warned about by type and path only', () => {
    const warn = vi.fn()
    createFrameGuard(context(), { warn }).receive(Buffer.from(JSON.stringify(brokenSpawn)))
    expect(warn).toHaveBeenCalledWith(
      'dropped a malformed control frame',
      expect.objectContaining({ direction: 'inbound', type: 'spawn' }),
    )
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('geometry')
    expect(logged).not.toContain(PLANTED)
    expect(logged).not.toContain(Buffer.from(PLANTED).toString('base64'))
  })

  it('a malformed promote frame holding the vault key is warned about by type and path only', () => {
    const warn = vi.fn()
    // Obviously fake: a well-formed base64 string of 32 bytes, as the schema wants.
    const plantedKey = Buffer.from('FAKE-planted-vault-data-key-0042').toString('base64')
    createFrameGuard(context(), { warn }).receive(
      Buffer.from(
        JSON.stringify({
          type: 'serverTransferPromoteRequest',
          requestId: 'st-1',
          transferId: '00000000-0000-4000-8000-000000000042',
          manifestDigest: 'a'.repeat(64),
          publicUrl: 'https://podium.example',
          bindHost: '0.0.0.0',
          port: 'not-a-port',
          targetMode: 'server',
          idempotencyKey: '00000000-0000-4000-8000-000000000042',
          vaultDataKey: plantedKey,
        }),
      ),
    )
    expect(warn).toHaveBeenCalledWith(
      'dropped a malformed control frame',
      expect.objectContaining({ direction: 'inbound', type: 'serverTransferPromoteRequest' }),
    )
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('err')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(plantedKey)
  })

  it('a malformed frame of another type still carries its error (canary)', () => {
    const warn = vi.fn()
    createFrameGuard(context(), { warn }).receive(
      Buffer.from(JSON.stringify({ type: 'kill', sessionId: 42, marker: PLANTED })),
    )
    expect(warn.mock.calls[0]?.[1]).toHaveProperty('err')
  })
})
