/**
 * ARMED OWNERSHIP GUARD (this issue, spec §5): the client relay must never
 * summon a process — the session layer does.
 *
 * The relay is constructed with the session layer's client scope
 * (`SessionClientScope` over a recording durable) as its ONLY process path. A
 * client open driven through that scope must succeed, summoning exactly one
 * client master into the durable — the relay only renders. A relay
 * constructed WITHOUT the scope refuses loudly instead of forking a child no
 * restart could re-adopt.
 *
 * There are deliberately NO `DaemonSession` client delegates: the scope IS
 * the session layer's arm (one instance over the daemon's client durable,
 * handed to the relay; per-session identity travels as the label value). A
 * forwarding method on the per-session entry would add a hop and no decision,
 * so the entry holds no scope and exposes no client verb — and this guard
 * wires none.
 */

import { asSessionId } from '@podium/model'
import type { DurableAttachment, DurableProcess } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import { createSessionClientScope } from '../session/clients.js'
import { SessionRegistry } from '../session/registry.js'
import { createOpencodeClientTerminals, opencodeAttachLabel } from './opencode-attach.js'

const SESSION = asSessionId('44444444-4444-4444-8444-444444444444')
const TARGET = {
  kind: 'opencode',
  conversation: 'ses_guard',
  endpoint: { address: 'http://127.0.0.1:41234', username: 'podium', secret: 'guard-secret' },
  workdir: '/tmp',
} as const

/** A stand-in for the client PTY: records nothing, renders nothing. */
function fakeAttachment(): DurableAttachment {
  return {
    pid: 4242,
    adopted: false,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: () => {},
    redraw: () => {},
    redrawWhenReady: () => {},
    dispose: () => {},
  } as unknown as DurableAttachment
}

function recordingScope(calls: string[]) {
  const adapter = {
    kind: 'abduco',
    spawn: async (opts: { label: string }) => {
      calls.push(`spawn:${opts.label}`)
      return fakeAttachment()
    },
    kill: async (label: string) => {
      calls.push(`kill:${label}`)
    },
    hasMasterSync: (label: string) => {
      calls.push(`probe:${label}`)
      return true
    },
  }
  const recordingDurable = {
    backend: 'abduco',
    primary: adapter,
    all: [adapter],
    spawn: adapter.spawn,
    kill: adapter.kill,
    hasMasterSync: adapter.hasMasterSync,
  } as unknown as DurableProcess
  const scope = createSessionClientScope(recordingDurable)
  expect(scope).toBeDefined()
  return scope!
}

describe('client lifecycle ownership (§5: the session summons, the relay renders)', () => {
  it('a client open through the session scope summons through the session owner', async () => {
    const calls: string[] = []
    const clients = recordingScope(calls)
    const terminals = createOpencodeClientTerminals({
      sessions: new SessionRegistry(),
      clients,
      frames: () => {},
    })

    await terminals.attach({ sessionId: SESSION, target: TARGET })
    // A live record is reclaimed without a probe; an adoption holds no
    // session and probes by label.
    await terminals.close(SESSION)
    terminals.adopt(SESSION)

    const label = opencodeAttachLabel(SESSION)
    expect(calls).toEqual([`spawn:${label}`, `kill:${label}`, `probe:${label}`])
  })

  it('a relay with no session owner refuses instead of summoning', () => {
    expect(() =>
      createOpencodeClientTerminals({
        sessions: new SessionRegistry(),
        frames: () => {},
      } as unknown as Parameters<typeof createOpencodeClientTerminals>[0]),
    ).toThrow(/requires ports\.clients/)
  })
})
