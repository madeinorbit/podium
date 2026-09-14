/**
 * MODE-AWARE REOPEN — server half (POD-3918 P1b).
 *
 * Normal screen: the byte stream IS the history, so a fresh attach replays
 * the log and the result matches what the screen held.
 *
 * Alternate screen: the program owns the canvas and the retained bytes were
 * produced at a possibly different size, so replaying them is wrong in
 * principle. A fresh attach sends NO replay bytes; the daemon reconstitutes
 * from its headless model (same size) or repaints after the size is agreed
 * (different size), and the redraw below is what asks it to.
 */

import { asSessionId, type Geometry } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import { asUserId, firstAdminMemberId } from '@podium/model'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionTerminal } from './terminal'

const SESSION = asSessionId('s-reopen')
const OWNER = asUserId(firstAdminMemberId())
const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'

type Sent = ClientConn & { sent: ServerMessage[]; principal: ClientPrincipal }

function makeClient(id: string): Sent {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: userClientPrincipal(id, OWNER, 'admin'),
    send: (m: ServerMessage) => sent.push(m),
    viewports: new Map(),
    viewportSeq: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  }
}

function makeTerminal(geometry: Geometry = { cols: 80, rows: 24 }): {
  terminal: SessionTerminal
  toDaemon: ControlMessage[]
} {
  const toDaemon: ControlMessage[] = []
  const terminal = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...geometry },
    toDaemon: (m) => toDaemon.push(m),
  })
  return { terminal, toDaemon }
}

const outputFrames = (client: Sent): ServerMessage[] =>
  client.sent.filter((m) => m.type === 'outputFrame')
const redraws = (toDaemon: ControlMessage[]): ControlMessage[] =>
  toDaemon.filter((m) => m.type === 'redraw')

describe('mode-aware reopen (server half)', () => {
  it('reopening a NORMAL-screen session replays bytes matching what the screen held', () => {
    const { terminal } = makeTerminal()
    terminal.acceptOutput(Buffer.from('shell line one\r\nshell line two\r\n', 'latin1'), 1)
    const client = makeClient('c-normal')
    terminal.attachClient(client)
    const frames = outputFrames(client)
    expect(frames.length).toBeGreaterThan(0)
    const replayed = Buffer.concat(
      frames.map((m) =>
        Buffer.from((m as Extract<ServerMessage, { type: 'outputFrame' }>).data, 'base64'),
      ),
    ).toString('latin1')
    expect(replayed).toContain('shell line one')
    expect(replayed).toContain('shell line two')
  })

  it('reopening an ALTERNATE-screen session replays NO stale bytes but still redraws', () => {
    const { terminal, toDaemon } = makeTerminal()
    terminal.acceptOutput(Buffer.from(ENTER_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('\x1b[HAgent TUI frame', 'latin1'), 1)
    const client = makeClient('c-alt')
    terminal.attachClient(client)
    expect(client.sent.some((m) => m.type === 'attached')).toBe(true)
    // The retained bytes were produced at whatever grid was current then;
    // replaying them into this grid is exactly the corruption. The daemon's
    // model reconstitution (same size) or repaint (different size) is the
    // first frame instead.
    expect(outputFrames(client)).toEqual([])
    expect(redraws(toDaemon)).toHaveLength(1)
    expect(redraws(toDaemon)[0]).toMatchObject({ type: 'redraw', replayRequired: true })
  })

  it('reopening an ALTERNATE session produced at a DIFFERENT size still replays nothing', () => {
    // Produced at 80 cols; the viewer reopens at 40 (W already moved).
    const { terminal, toDaemon } = makeTerminal({ cols: 40, rows: 24 })
    terminal.acceptOutput(Buffer.from(ENTER_ALT, 'latin1'), 1)
    terminal.acceptOutput(
      Buffer.from(`\x1b[H+${'-'.repeat(78)}+\r\n| eighty-wide TUI |\r\n`, 'latin1'),
      1,
    )
    const client = makeClient('c-alt-small')
    terminal.attachClient(client)
    expect(outputFrames(client)).toEqual([])
    expect(redraws(toDaemon)).toHaveLength(1)
  })

  it('leaving the alternate screen restores byte replay', () => {
    const { terminal } = makeTerminal()
    terminal.acceptOutput(Buffer.from(ENTER_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('tui', 'latin1'), 1)
    terminal.acceptOutput(Buffer.from(LEAVE_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('back at the prompt\r\n', 'latin1'), 1)
    const client = makeClient('c-back')
    terminal.attachClient(client)
    const replayed = Buffer.concat(
      outputFrames(client).map((m) =>
        Buffer.from((m as Extract<ServerMessage, { type: 'outputFrame' }>).data, 'base64'),
      ),
    ).toString('latin1')
    expect(replayed).toContain('back at the prompt')
  })
})
