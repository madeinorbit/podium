import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { PERMITTED_FAILURES } from '../../permitted-failures.js'
// The assertion, not a copy of it: the refusal worlds below are judged by the
// same corpus function the run judges its endpoint arm with. From the module
// rather than the `testing/` barrel, which is the corpus's surface to curate.
import { assertAttachHonoursOneControlLease } from '../../testing/conformance/suite.js'
import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { runConformance } from '../../testing/index.js'
import { createGrokAcpClient } from './client.js'
import {
  createGrokAcpRuntime,
  type GrokAcpEndpoint,
  type GrokAcpJournal,
  type GrokAcpJournalEntry,
  type GrokAcpRuntime,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import { type FakeGrokAcpServer, startFakeGrokAcpServer } from './test-support/fake-acp-server.js'

/**
 * THE ONE HOST FACT THIS FILE VARIES, and it is a fact about the MACHINE rather
 * than about the driver: whether this box can run a Grok ACP client terminal,
 * and for which attach modes. The capability declares `client` in every one of
 * them — the variant this family produces does not change with the host — and
 * the driver turns a host that starts none into the corpus's typed refusal.
 *
 *   `true` (default)     both modes, the ordinary machine;
 *   `false`              neither — nowhere to run a terminal at all;
 *   `'spectators-only'`  a read-only stream for watchers, but no seat to put a
 *                        controlling human in.
 *
 * The third is not a shape invented to make a test pass: it is the ONLY host
 * under which the corpus reaches its refused-TAKEOVER assertion, because
 * `assertAttachHonoursOneControlLease` returns at a refused peek, so a host that
 * refuses everything never gets as far as asking for control. Both refusal
 * worlds are `describe`s at the bottom of this file.
 */
interface WorldOptions {
  hostsClientTerminals?: boolean | 'spectators-only'
}

function makeWorld(options: WorldOptions = {}): {
  target: ConformanceTarget
  failProviderTurn(sessionId: SessionId, detail: string): void
  failNextPrompt(sessionId: SessionId, detail?: string): void
} {
  const hostsClientTerminals = options.hostsClientTerminals ?? true
  let runtime: GrokAcpRuntime | undefined
  let replayPromptSettlement: (() => void) | undefined
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const journal: GrokAcpJournal = {
    read: (id) => entries.get(id),
    write: (entry) => entries.set(entry.sessionId, entry),
    clear: (id) => {
      entries.delete(id)
    },
  }
  const processKey = (id: SessionId): string => `podium-gk-${id}`
  const host: GrokAcpRuntimeHost = {
    journal,
    now: () => Date.UTC(2026, 7, 16) + ++seq * 1000,
    mintSessionId: () => `gk-session-${++seq}` as SessionId,
    makeClient(config) {
      const client = createGrokAcpClient(config)
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'call') return Reflect.get(target, property, receiver)
          return (method: string, params?: unknown): Promise<unknown> => {
            const promise = client.call(method, params)
            if (method !== 'session/prompt') return promise
            // A native Promise settles once, while the driver fence must also
            // absorb a provider adapter that delivers the same settlement
            // twice. This replayable thenable exposes that exact boundary.
            return {
              then(
                onfulfilled: (value: unknown) => unknown,
                onrejected: (reason: unknown) => unknown,
              ): Promise<unknown> {
                return promise.then((value) => {
                  replayPromptSettlement = () => {
                    void onfulfilled(value)
                  }
                  return onfulfilled(value)
                }, onrejected)
              },
            } as Promise<unknown>
          }
        },
      })
    },
    async launch(input) {
      const nativeId =
        entries.get(input.sessionId)?.grokSessionId ?? `grok-native-${input.sessionId}`
      replayPromptSettlement = undefined
      const server = startFakeGrokAcpServer(nativeId, {
        onReplayedPromptResult: () => replayPromptSettlement?.(),
      })
      servers.get(input.sessionId)?.crash()
      servers.set(input.sessionId, server)
      const endpoint: GrokAcpEndpoint = {
        transport: server.transport,
        process: {
          key: processKey(input.sessionId),
          pid: 5000 + seq,
          scopeUnit: `${processKey(input.sessionId)}.scope`,
        },
        stop: async () => server.crash(),
        kill: async () => {
          server.crash()
          servers.delete(input.sessionId)
        },
        resources: () => ({ memoryBytes: 80 * 1024 * 1024, oomKills: 0 }),
        alive: () => server.alive,
      }
      return endpoint
    },
    readArchive: async () => [{ path: 'updates.jsonl', bytes: new TextEncoder().encode('{}\n') }],
    // `mode` HAS ALWAYS BEEN ON THE HOST CONTRACT — a real host needs it to
    // decide what to spawn — and a machine that hands a watcher a read-only
    // stream while refusing to seat a controller is what makes the corpus's
    // second refusal assertion reachable at all. See {@link WorldOptions}.
    attachClient: async ({ sessionId, mode }) => {
      if (hostsClientTerminals === false) return undefined
      if (hostsClientTerminals === 'spectators-only' && mode === 'takeover') return undefined
      return { streamId: `grok-client-${sessionId}`, warmTtlMs: 300_000 }
    },
  }
  const serverFor = (id: SessionId): FakeGrokAcpServer => {
    const server = servers.get(id)
    if (!server) throw new Error(`no fake Grok ACP server for ${id}`)
    return server
  }
  const control: ConformanceControl = {
    askInteraction(sessionId) {
      return serverFor(sessionId).askPermission()
    },
    reaskInteraction(sessionId) {
      return serverFor(sessionId).askPermission()
    },
    async completeTurn(sessionId) {
      serverFor(sessionId).completeTurn()
      // The response settles a Promise; yielding here makes this control a
      // causal barrier before the corpus sends its later ordering witness.
      await Promise.resolve()
    },

    /**
     * The chunk run alone — no item follows it here, because in this family
     * nothing does. grok accumulates chunks into a buffer and flushes ONE
     * complete item at the prompt's resolution, so the completed item the
     * corpus joins against is produced by `completeTurn`, not by this call. That
     * is the whole reason the join property is stated over the TURN rather than
     * over an adjacent pair of events.
     */
    async streamAssistantText(sessionId, chunks) {
      serverFor(sessionId).streamAgentText(chunks)
      await Promise.resolve()
    },

    async failTurn(sessionId) {
      serverFor(sessionId).completeTurn('refusal')
      await Promise.resolve()
    },
    processEvent(sessionId, ev) {
      if (ev.ev === 'exited') serverFor(sessionId).crash()
    },
    failNextVerification(sessionId) {
      serverFor(sessionId).failNextPrompt()
    },
    textDeliveries(sessionId) {
      return serverFor(sessionId).promptCount
    },
    restartSupervisor() {
      for (const [sessionId, server] of servers) {
        runtime?.forget(sessionId)
        server.crash()
      }
    },
    connectWithoutSecret() {
      return { refused: true }
    },
  }
  return {
    failProviderTurn: (sessionId, detail) => serverFor(sessionId).failProviderTurn(detail),
    failNextPrompt: (sessionId, detail) => serverFor(sessionId).failNextPrompt(detail),
    target: {
      name: 'grok-acp',
      family: 'server',
      createDriver: () => {
        runtime = createGrokAcpRuntime(host)
        return { driver: runtime.driver, control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        for (const server of servers.values()) server.crash()
        servers.clear()
        entries.clear()
        replayPromptSettlement = undefined
        seq = 0
      },
      spec: () => ({
        harness: 'grok',
        selection: {
          auth: 'subscription',
          platform: 'linux',
          available: ['grok-acp'],
          preference: 'grok-acp',
        },
        workdir: '/tmp/conformance-grok',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()

async function eventsThroughTurnFailure(handle: AgentSessionHandle): Promise<RuntimeEvent[]> {
  const observed: RuntimeEvent[] = []
  let sawTurnFailure = false
  let sawStateFailure = false
  for await (const event of handle.events('bootstrap')) {
    observed.push(event)
    if (event.t === 'turn' && event.ev.ev === 'failed') sawTurnFailure = true
    if (event.t === 'state' && event.change.kind === 'turn_failed') sawStateFailure = true
    if (sawTurnFailure && sawStateFailure) break
  }
  return observed
}

describe('grok-acp provider failure detail', () => {
  it('keeps a causal 402 detail when the prompt response closes the turn', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      await handle.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
      world.failProviderTurn(
        handle.binding.sessionId,
        'API error (status 402 Payment Required): Grok Build usage balance exhausted',
      )
      const observed = await eventsThroughTurnFailure(handle)

      expect(observed).toContainEqual(
        expect.objectContaining({
          t: 'state',
          change: expect.objectContaining({
            kind: 'turn_failed',
            errorClass: 'usage_limit',
            retryable: false,
            detail: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
          }),
        }),
      )
      expect(observed).toContainEqual(
        expect.objectContaining({
          t: 'turn',
          ev: expect.objectContaining({
            ev: 'failed',
            disposition: 'needs-human',
            detail: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
          }),
        }),
      )
      await expect(handle.state()).resolves.toMatchObject({
        phase: 'errored',
        error: {
          class: 'usage_limit',
          retryable: false,
          detail: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
        },
      })
    } finally {
      world.target.reset()
    }
  })

  it('classifies an immediate 402 prompt rejection before chat materialization', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    const detail = 'API error (status 402 Payment Required): Grok Build usage balance exhausted'
    try {
      const handle = await driver.create(world.target.spec())
      world.failNextPrompt(handle.binding.sessionId, detail)
      await handle.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
      const observed = await eventsThroughTurnFailure(handle)

      const stateFailure = observed.find(
        (entry) => entry.t === 'state' && entry.change.kind === 'turn_failed',
      )
      if (!stateFailure || stateFailure.t !== 'state') {
        throw new Error('missing immediate rejection state failure')
      }
      expect(stateFailure.change).toEqual({
        kind: 'turn_failed',
        errorClass: 'usage_limit',
        retryable: false,
        detail,
      })

      const turnFailure = observed.find(
        (entry) => entry.t === 'turn' && entry.ev.ev === 'failed',
      )
      if (!turnFailure || turnFailure.t !== 'turn') {
        throw new Error('missing immediate rejection turn failure')
      }
      expect(turnFailure.ev).toMatchObject({
        ev: 'failed',
        disposition: 'needs-human',
        detail,
      })
      await expect(handle.state()).resolves.toMatchObject({
        phase: 'errored',
        error: { class: 'usage_limit', retryable: false, detail },
      })
    } finally {
      world.target.reset()
    }
  })
})

/**
 * THE REFUSAL ARM, ON A REAL DRIVER (POD-2486; the arms are POD-2121's and
 * POD-2131's, landed for opencode first and byte-equivalent here).
 *
 * `assertAttachHonoursOneControlLease` branches on whether the driver hands back
 * an ENDPOINT or a REFUSAL, and the refusal side carries the invariant with
 * teeth: a refused take-over must not be holding the control lease. The fixture
 * above returned an endpoint unconditionally, so this driver only ever took the
 * endpoint branch, and `runtime.ts`'s reserve-then-roll-back — the `!endpoint`
 * arm that puts `previousLease` back — was guarded by nothing on this family.
 * POD-2131's reviewer found the same hole here and in codex after fixing it for
 * opencode; this is that fix.
 *
 * WHY NOT A SECOND FULL `runConformance`. Nothing else in the corpus reads
 * `attachClient`, so a second whole-corpus pass would re-prove ~90 properties to
 * reach one branch. The suite exports the assertion for exactly this.
 */
describe('grok-acp on a host with nowhere to run a terminal', () => {
  it('refuses the attach, typed, and does not walk off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: false })
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())

      /**
       * THE ARM IS PINNED BEFORE THE PROPERTY RUNS, because the property is
       * satisfied by EITHER arm and would go green on this world without ever
       * reaching the refusal branch — the exact failure that kept the branch
       * dormant, reproduced one level up.
       *
       * `supported` stays TRUE: a declared attach refused by a particular
       * machine, not a family with no terminal at all. Pinning here forces the
       * CLASSIFICATION path — a refusal must be typed — to run, and no more: a
       * peek never touches the lease, so no mode-guarded driver can fail that
       * half. The `describe` below is the one with teeth.
       */
      expect(driver.capabilities().attach.supported).toBe(true)
      expect(await handle.attach({ mode: 'peek', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

/**
 * THE HALF WITH THE TEETH: A REFUSED TAKE-OVER IS NOT HOLDING THE LEASE.
 *
 * A box that can pipe a read-only stream to watchers and has no seat for a
 * controlling human. The peek succeeds and only the take-over is refused, and
 * that ordering is the whole point: `assertAttachHonoursOneControlLease` RETURNS
 * at a refused peek, so the world above never gets as far as asking for control,
 * while the ordinary world hosts both and never refuses at all.
 *
 * What it pins in THIS driver: `attach` reserves the lease before awaiting
 * `host.attachClient`, so the invariant rides entirely on the rollback in the
 * `!endpoint` branch. Delete `session.lease = previousLease` there and a caller
 * refused control is nonetheless recorded as the human controller — the steward
 * will not nudge, `lease.acquire` refuses the next comer with `lease_held`, and
 * no terminal exists for anyone to type into.
 *
 * THE PIN NEEDS A SESSION OF ITS OWN, and that is load-bearing rather than tidy.
 * The pin has to establish that on this world a peek yields an endpoint and a
 * take-over is refused, or the property could be satisfied through the endpoint
 * branch and prove nothing. But the pin's own take-over IS the call under test,
 * and a driver with the bug leaves the lease taken behind it; pinning on the
 * judged session would then hand the property a poisoned starting state, since
 * it reads the lease BEFORE its own take-over and compares the two, so a lease
 * already wrongly held reads as "unchanged" and the bug passes. MEASURED ON THIS
 * DRIVER, not inherited from opencode's finding (POD-2131): with the rollback
 * deleted, judging the property on the probe session instead of a fresh one
 * leaves the whole package green. Two fresh sessions answer it — the pin is a
 * statement about the MACHINE, which the host decides per call off `mode` alone,
 * so it holds for both.
 */
describe('grok-acp on a host that streams to watchers but seats no controller', () => {
  it('refuses the take-over without walking off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: 'spectators-only' })
    const { driver } = world.target.createDriver()
    try {
      const probe = await driver.create(world.target.spec())
      expect(driver.capabilities().attach.supported).toBe(true)
      expect('kind' in (await probe.attach({ mode: 'peek', holder: 'probe' }))).toBe(true)
      expect(await probe.attach({ mode: 'takeover', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      // The judged session is a FRESH one, untouched by the pin above.
      const handle = await driver.create(world.target.spec())
      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

runConformance(target.createDriver, {
  name: target.name,
  family: target.family,
  reset: target.reset,
  spec: target.spec,
  exemptions: PERMITTED_FAILURES.server,
})
