/**
 * ARMED OWNERSHIP GUARD (this issue, spec §4.8 steps 2 and 6): the driver
 * family must never summon a process — the session layer does.
 *
 * The grok family is constructed with a supervision port whose every process
 * verb throws, and a session-owned engine owner over a recording durable. A
 * launch driven through the `DaemonSession` must succeed WITHOUT touching
 * the throwing port.
 *
 * RED before the migration (the family called `supervision.spawnHeadless`
 * and blew up on the throwing port); GREEN after (the spawn flows through
 * the session owner into the durable, the family only binds protocol).
 */

import { asSessionId } from '@podium/model'
import type { EngineProcessOwner, EngineSupervisor } from '@podium/harness/driver/host'
import { createGrokEngineHost, grokEngineFacts } from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import type { DurableProcess } from '@podium/process/durable'
import { describe, expect, it } from 'vitest'
import { grokAcpProcessKey } from '@podium/harness/driver/host'
import { createSessionEngineScope } from './engines.js'
import { SessionRegistry } from './registry.js'

const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')
const FACTS = grokEngineFacts(manifestFor('grok')!)

describe('engine lifecycle ownership (§4.8: the session summons, the family binds)', () => {
  it('a family launch driven through DaemonSession never touches supervision verbs', async () => {
    const supervisionCalls: string[] = []
    const throwing: EngineSupervisor = {
      spawnHeadless: async () => {
        supervisionCalls.push('spawnHeadless')
        throw new Error('the family must not spawn: the session owns the engine')
      },
      attachHeadless: async () => {
        supervisionCalls.push('attachHeadless')
        throw new Error('the family must not re-attach: the session owns the engine')
      },
      has: async () => {
        supervisionCalls.push('has')
        throw new Error('the family must not probe: the session owns the engine')
      },
      kill: async () => {
        supervisionCalls.push('kill')
        throw new Error('the family must not reap: the session owns the engine')
      },
      scopeUnitFor: () => undefined,
    }

    const spawned: Array<{ label: string; cmd: string }> = []
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
    const recordingDurable = {
      backend: 'host',
      primary: {
        kind: 'host',
        spawnHeadless: async (opts: { label: string; cmd: string }) => {
          spawned.push({ label: opts.label, cmd: opts.cmd })
          return attachment
        },
      },
      all: [],
    } as unknown as DurableProcess
    recordingDurable.all = [recordingDurable.primary] as DurableProcess['all']

    const sessions = new SessionRegistry()
    sessions.bindEngines(createSessionEngineScope(recordingDurable))
    const session = sessions.ensure(SESSION)
    // The launch flows through the session object: every verb below is a
    // `DaemonSession` delegate into the bound scope.
    const engines: EngineProcessOwner = {
      startEngine: (req) => session.spawnEngine(req),
      reattachEngine: (input) => session.reattachEngine(input.label),
      engineAlive: (label) => session.engineAlive(label),
      destroyEngine: (label) => session.killEngine(label),
    }

    const deps = {
      facts: FACTS,
      journal: { read: () => undefined, write: () => {}, clear: () => {} },
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => ({ drivable: true as const }),
      supervision: throwing,
      // Ignored until the family migrates off supervision verbs; then this is
      // the only process path the family may use.
      engines,
    } as unknown as Parameters<typeof createGrokEngineHost>[0]
    const host = createGrokEngineHost(deps)

    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    expect(endpoint.process.key).toBe(grokAcpProcessKey(FACTS, SESSION))
    expect(endpoint.alive()).toBe(true)
    // The session layer summoned exactly one engine, under the session label.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      label: grokAcpProcessKey(FACTS, SESSION),
      cmd: 'grok',
    })
    // …and the family's own supervision verbs were never consulted.
    expect(supervisionCalls).toEqual([])
  })
})
