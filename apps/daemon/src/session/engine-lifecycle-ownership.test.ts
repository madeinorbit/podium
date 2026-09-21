/**
 * ARMED OWNERSHIP GUARD (spec §4.8 steps 2 and 6): the driver family must
 * never summon a process — the session layer does.
 *
 * The grok family is constructed with a scope-only supervision port and the
 * session layer's engine scope (`SessionEngineScope` over a recording
 * durable) as its ONLY process path. A launch driven through that scope must
 * succeed, summoning exactly one engine into the durable — the family only
 * binds protocol. A family constructed WITHOUT the scope refuses loudly
 * instead of forking a child no restart could re-adopt.
 *
 * There are deliberately NO `DaemonSession` engine delegates: the scope IS
 * the session layer's arm (one instance over the daemon's engine durable,
 * handed to the long-lived families; per-session identity travels as the
 * label value). A forwarding method on the per-session entry would add a hop
 * and no decision, so the entry holds no scope and exposes no engine verb —
 * and this guard wires none.
 */

import { asSessionId } from '@podium/model'
import type { EngineSupervisor } from '@podium/harness/driver/host'
import { createGrokEngineHost, grokEngineFacts } from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import type { DurableProcess } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import { grokAcpProcessKey } from '@podium/harness/driver/host'
import { createSessionEngineScope } from './engines.js'

const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')
const FACTS = grokEngineFacts(manifestFor('grok')!)

function recordingScope(spawned: Array<{ label: string; cmd: string }>) {
  const attachment = {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
      write: async () => 0,
    },
    dispose: () => {},
  }
  const hostAdapter = {
    kind: 'host',
    spawnHeadless: async (opts: { label: string; cmd: string }) => {
      spawned.push({ label: opts.label, cmd: opts.cmd })
      return attachment
    },
  }
  const recordingDurable = {
    backend: 'host',
    primary: hostAdapter,
    all: [hostAdapter],
  } as unknown as DurableProcess
  return createSessionEngineScope(recordingDurable)
}

function familyDeps(
  supervision: EngineSupervisor,
  engines: unknown,
) {
  return {
    facts: FACTS,
    journal: { read: () => undefined, write: () => {}, clear: () => {} },
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => ({ drivable: true as const }),
    supervision,
    engines,
  } as unknown as Parameters<typeof createGrokEngineHost>[0]
}

describe('engine lifecycle ownership (§4.8: the session layer summons, the family binds)', () => {
  it('a family launch through the session scope summons through the session owner', async () => {
    // Scope-only: the supervision port carries no process verb any more, so
    // there is nothing here FOR the family to summon through.
    const supervision: EngineSupervisor = {
      scopeUnitFor: () => undefined,
    }

    const spawned: Array<{ label: string; cmd: string }> = []
    const sessionEngines = recordingScope(spawned)
    const host = createGrokEngineHost(familyDeps(supervision, sessionEngines))

    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    expect(endpoint.process.key).toBe(grokAcpProcessKey(FACTS, SESSION))
    expect(endpoint.alive()).toBe(true)
    // The session layer summoned exactly one engine, under the session label.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      label: grokAcpProcessKey(FACTS, SESSION),
      cmd: 'grok',
    })
  })

  it('a family with no session owner refuses instead of summoning', async () => {
    const supervision: EngineSupervisor = {
      scopeUnitFor: () => undefined,
    }
    const host = createGrokEngineHost(familyDeps(supervision, undefined))
    await expect(host.launch({ sessionId: SESSION, workdir: '/tmp' })).rejects.toThrow(
      /requires the session engine owner/,
    )
  })
})
