import { CLIENT_WIRE_VERSION } from '@podium/protocol'
/** Live-only attaches on sessions without pictures (SPEC v4 B3, H6). */

import { asSessionId, asUserId, firstAdminMemberId, type Geometry } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
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
    attached: new Set(),
    caps: new Set(),
    wireVersion: CLIENT_WIRE_VERSION,
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
  terminal.setPictures(false)
  return { terminal, toDaemon }
}

const outputFrames = (client: Sent): ServerMessage[] =>
  client.sent.filter((m) => m.type === 'outputFrame')
const redraws = (toDaemon: ControlMessage[]): ControlMessage[] =>
  toDaemon.filter((m) => m.type === 'redraw')

describe('live-only reopen without pictures', () => {
  it('reopening a normal-screen session receives live bytes only', () => {
    const { terminal } = makeTerminal()
    terminal.acceptOutput(Buffer.from('shell line one\r\nshell line two\r\n', 'latin1'), 1)
    const client = makeClient('c-normal')
    terminal.attachClient(client)
    expect(outputFrames(client)).toEqual([])
    terminal.acceptOutput(Buffer.from('live line'), 1)
    expect(outputFrames(client)).toHaveLength(1)
  })

  it('reopening an alternate-screen session gets no history or automatic redraw', () => {
    const { terminal, toDaemon } = makeTerminal()
    terminal.acceptOutput(Buffer.from(ENTER_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('\x1b[HAgent TUI frame', 'latin1'), 1)
    const client = makeClient('c-alt')
    terminal.attachClient(client)
    expect(client.sent.some((m) => m.type === 'attached')).toBe(true)
    expect(outputFrames(client)).toEqual([])
    expect(redraws(toDaemon)).toEqual([])
  })

  it('a different viewer size does not cause history replay or automatic redraw', () => {
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
    expect(redraws(toDaemon)).toEqual([])
  })

  it('leaving the alternate screen still does not replay history', () => {
    const { terminal } = makeTerminal()
    terminal.acceptOutput(Buffer.from(ENTER_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('tui', 'latin1'), 1)
    terminal.acceptOutput(Buffer.from(LEAVE_ALT, 'latin1'), 1)
    terminal.acceptOutput(Buffer.from('back at the prompt\r\n', 'latin1'), 1)
    const client = makeClient('c-back')
    terminal.attachClient(client)
    expect(outputFrames(client)).toEqual([])
  })
})
