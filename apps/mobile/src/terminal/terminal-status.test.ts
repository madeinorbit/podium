import { describe, expect, it } from 'vitest'
import { terminalControlView } from './terminal-control'
import { terminalStatusLine } from './terminal-status'

/**
 * The shared pane decisions both renderers speak — the react-native-web pane
 * and the native pane's DOM component. The WORDS are pinned exactly because
 * terminal-pane.test.tsx (web) and the webview page both query/render them;
 * a drifted sentence would pass one surface and lie on the other.
 */
describe('terminalStatusLine', () => {
  const base = { connected: true, spawnPending: false, ready: true, outputSeen: true }

  it('walks the four waits in precedence order', () => {
    expect(terminalStatusLine({ ...base, connected: false })).toBe('Connecting terminal…')
    // The spawn wait outranks the attach wait: the create path waits on the
    // SERVER, and "Attaching" would name a step that has not begun (POD-1613).
    expect(
      terminalStatusLine({ ...base, spawnPending: true, ready: false, outputSeen: false }),
    ).toBe('Starting agent…')
    expect(terminalStatusLine({ ...base, ready: false, outputSeen: false })).toBe(
      'Attaching terminal…',
    )
    // The child's wait, from the server's durable output counter (POD-393).
    expect(terminalStatusLine({ ...base, outputSeen: false })).toBe('Attached — no output yet…')
  })

  it('says nothing once the terminal itself is the affordance', () => {
    expect(terminalStatusLine(base)).toBeNull()
  })

  it('lets disconnection outrank everything — one sentence at a time', () => {
    expect(
      terminalStatusLine({ connected: false, spawnPending: true, ready: false, outputSeen: false }),
    ).toBe('Connecting terminal…')
  })
})

describe('terminalControlView', () => {
  it('maps a spectator snapshot to spectating on the server grid', () => {
    expect(
      terminalControlView({ role: 'spectator', cols: 103, rows: 28, requestedGeometry: null }),
    ).toEqual({ role: 'spectator', phase: 'spectating', cols: 103, rows: 28 })
  })

  it('reports fitting while ANY geometry claim is unacknowledged — role alone is not success', () => {
    expect(
      terminalControlView({
        role: 'controller',
        cols: 103,
        rows: 28,
        requestedGeometry: { cols: 62, rows: 36 },
      }).phase,
    ).toBe('fitting')
    expect(
      terminalControlView({
        role: 'spectator',
        cols: 103,
        rows: 28,
        requestedGeometry: { cols: 62, rows: 36 },
      }).phase,
    ).toBe('fitting')
  })

  it('reports controlling only once the acknowledged geometry is authoritative', () => {
    expect(
      terminalControlView({ role: 'controller', cols: 62, rows: 36, requestedGeometry: null }),
    ).toEqual({ role: 'controller', phase: 'controlling', cols: 62, rows: 36 })
  })
})
