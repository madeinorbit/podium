import type { SessionCallbacks } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalBridge,
  initialBridgeState,
  type TerminalDomActions,
} from './terminal-dom-bridge'

/**
 * The webview side of the native terminal's transport seam: just enough
 * hub/connection for `mountSession` to run unchanged, with every mutation
 * forwarded to the native actions and every native push fanned into the
 * mount's callbacks. Pure logic — the pinned behaviors are the ones a live
 * defect would surface as a blank or lying terminal:
 *
 *   - attach/detach latching (the native attach frame is one-shot, POD-1613)
 *   - the state MIRROR: `connection.state()` must answer synchronously with
 *     the last state the native connection published
 *   - forwarding fidelity for input/resize/viewport/control/redraw.
 */

const SESSION = asSessionId('sess-bridge')

function actionsHarness() {
  const actions = {
    onAttachTerminal: vi.fn(async () => {}),
    onDetachTerminal: vi.fn(async () => {}),
    onSendInput: vi.fn(async () => {}),
    onSendResize: vi.fn(async () => {}),
    onReportViewport: vi.fn(async () => {}),
    onRequestControl: vi.fn(async () => {}),
    onRedraw: vi.fn(async () => {}),
  } satisfies TerminalDomActions
  return { actions, box: { current: actions as TerminalDomActions } }
}

let harness: ReturnType<typeof actionsHarness>

beforeEach(() => {
  harness = actionsHarness()
})

describe('createTerminalBridge', () => {
  it('requests the native attach exactly once per attach cycle, and detaches symmetrically', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    bridge.hub.attach(SESSION, {})
    // A re-mount that attaches while attached only swaps callbacks — the real
    // hub behaves the same way for a live connection, and a second native
    // attach would be a no-op frame at best and a callback fork at worst.
    bridge.hub.attach(SESSION, {})
    expect(harness.actions.onAttachTerminal).toHaveBeenCalledTimes(1)

    bridge.hub.detach(SESSION)
    bridge.hub.detach(SESSION)
    expect(harness.actions.onDetachTerminal).toHaveBeenCalledTimes(1)

    // The next mount is a fresh cycle.
    bridge.hub.attach(SESSION, {})
    expect(harness.actions.onAttachTerminal).toHaveBeenCalledTimes(2)
  })

  it('answers state() from the mirror: default posture first, then whatever native last pushed', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})
    // The pre-attach posture a fresh SessionConnection reports: disconnected
    // spectator, outputSeen optimistic (silence must never be accused early).
    expect(conn.state()).toEqual(initialBridgeState(SESSION))

    const next = {
      ...initialBridgeState(SESSION),
      connected: true,
      clientId: 'c1',
      controllerId: 'c2',
      cols: 103,
      rows: 28,
      epoch: 3,
    }
    const seen: unknown[] = []
    bridge.hub.attach(SESSION, { onState: (s) => seen.push(s) })
    bridge.push.state(next)
    expect(conn.state()).toEqual(next)
    expect(seen).toEqual([next])
  })

  it('fans native pushes into the CURRENT callbacks, and none after detach', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const cb = {
      onFrame: vi.fn(),
      onReset: vi.fn(),
      onAttached: vi.fn(),
    } satisfies SessionCallbacks
    bridge.hub.attach(SESSION, cb)

    bridge.push.frame('hello')
    bridge.push.reset()
    bridge.push.attached()
    expect(cb.onFrame).toHaveBeenCalledWith('hello')
    expect(cb.onReset).toHaveBeenCalledTimes(1)
    expect(cb.onAttached).toHaveBeenCalledTimes(1)

    bridge.hub.detach(SESSION)
    bridge.push.frame('late')
    expect(cb.onFrame).toHaveBeenCalledTimes(1)
  })

  it('forwards every connection mutation to the native actions', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})

    conn.sendInput('ls\r')
    expect(harness.actions.onSendInput).toHaveBeenCalledWith('ls\r')
    conn.sendResize(62, 36)
    expect(harness.actions.onSendResize).toHaveBeenCalledWith(62, 36)
    conn.reportViewport(48, 30)
    expect(harness.actions.onReportViewport).toHaveBeenCalledWith(48, 30)
    conn.requestControl({ cols: 62, rows: 36 })
    expect(harness.actions.onRequestControl).toHaveBeenCalledWith({ cols: 62, rows: 36 })
    // A bare claim crosses as null — `undefined` does not survive JSON marshal.
    conn.requestControl()
    expect(harness.actions.onRequestControl).toHaveBeenLastCalledWith(null)
    conn.redraw()
    expect(harness.actions.onRedraw).toHaveBeenCalledTimes(1)
  })

  it('reads actions through the box, so a re-marshal never strands the mount on stale proxies', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})
    const replacement = actionsHarness()
    harness.box.current = replacement.box.current
    conn.sendInput('x')
    expect(harness.actions.onSendInput).not.toHaveBeenCalled()
    expect(replacement.actions.onSendInput).toHaveBeenCalledWith('x')
  })
})
