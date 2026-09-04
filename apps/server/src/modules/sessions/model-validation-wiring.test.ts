/**
 * The WIRING that pays off issue #534 [spec:SP-cc60]: createSession is the one spawn
 * funnel, so validating there is what actually stops a typo'd model from reaching the
 * daemon. These tests observe the real registry — a rejected selection produces NO
 * spawn frame and NO session; a forced unlisted model spawns AND leaves a durable
 * `agent.model_forced` event so the override is observable.
 */

import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, expect, it } from 'vitest'
import { MODEL_CATALOG_VERSION } from '../../model-catalog'
import { ModelValidationError } from '../../model-validation'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

async function storeWithCatalog(): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  await store.settings.setModelCatalog({
    machineId: store.hostMachineId,
    version: MODEL_CATALOG_VERSION,
    fetchedAt: 1_000_000,
    byAgent: {
      codex: [{ value: 'gpt-5.6', label: 'GPT-5.6', efforts: ['low', 'medium', 'high'] }],
    },
  })
  return store
}

function makeRegistry(store: SessionStore): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}

const spawnFrames = (daemon: ControlMessage[]) => daemon.filter((m) => m.type === 'spawn')

it('rejects an unlisted model before spawning — no frame, no session', async () => {
  const store = await storeWithCatalog()
  const { reg, daemon } = makeRegistry(store)
  let err: unknown
  try {
    reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/tmp/x', model: 'gpt-5.7' })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(ModelValidationError)
  expect((err as ModelValidationError).message).toContain('Did you mean "gpt-5.6"?')
  expect(spawnFrames(daemon)).toHaveLength(0)
  expect(reg.modules.sessions.listSessions()).toHaveLength(0)
})

it('rejects an unlisted effort with a suggestion', async () => {
  const store = await storeWithCatalog()
  const { reg } = makeRegistry(store)
  expect(() =>
    reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/tmp/x',
      model: 'gpt-5.6',
      effort: 'highh',
    }),
  ).toThrow(/unknown effort "highh".*Did you mean "high"/s)
})

it('force spawns the unlisted model AND records agent.model_forced', async () => {
  const store = await storeWithCatalog()
  const { reg, daemon } = makeRegistry(store)
  const { sessionId } = reg.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/tmp/x',
    model: 'gpt-6-experimental',
    forceUnknownModel: true,
  })
  expect(spawnFrames(daemon)).toHaveLength(1)
  const forced = (await store.events.listEventsSince(0, { kinds: ['agent.model_forced'] })).filter(
    (e) => e.subject === sessionId,
  )
  expect(forced).toHaveLength(1)
  expect(forced[0]?.payload).toMatchObject({ harness: 'codex', model: 'gpt-6-experimental' })
})

it('a known model spawns with no forced event', async () => {
  const store = await storeWithCatalog()
  const { reg, daemon } = makeRegistry(store)
  reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/tmp/x', model: 'gpt-5.6' })
  expect(spawnFrames(daemon)).toHaveLength(1)
  expect(await store.events.listEventsSince(0, { kinds: ['agent.model_forced'] })).toHaveLength(0)
})
