import {
  asMachineId,
  asSessionId,
  asUserId,
  type ContextDetailResult,
  type ContextSummary,
} from '@podium/model'
import {
  CAP_CONTEXT_OBSERVATION_V1,
  CAP_CONTEXT_READ_V1,
  type DaemonMessage,
  encodeDaemonMessage,
  parseControlMessage,
  parseDaemonMessage,
  type RuntimeContextReadRequestMessage,
  type SessionContextReadInput,
} from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeServerDriver,
  resetFakeRuntime,
} from '../../../../../packages/harness/src/driver/testing/fake-driver'
import {
  testHarnessContext,
  testSessionTerms,
} from '../../../../../packages/harness/src/driver/testing/harness-context'
import { unsupported } from '../../../../../packages/harness/src/manifest'
import type { DaemonContext } from '../../../../daemon/src/control/context'
import { dispatchControlMessage } from '../../../../daemon/src/control/registry'
import { userCommandPrincipal } from '../../command-principal'
import { DAEMON_FRAME_PORTS } from '../../gateway/daemon-frame-routing'
import { DaemonMux } from '../../gateway/daemon-mux'
import type { DaemonFeaturePorts } from '../../gateway/daemon-ports'
import { type Context, t } from '../../trpc'
import { queryProcedures } from '../derived-family'
import { DaemonRpcService } from '../machines/rpc'
import { SessionContextReads } from './context-reads'
import { SESSION_QUERIES } from './queries'

const at = '2026-11-21T12:00:00.000Z'
const quantity = (value: number) => ({
  value,
  accuracy: 'reported' as const,
  source: 'invented observation',
})
const machineId = asMachineId('invented-context-machine')
const owner = asUserId('invented-owner')
const releases: (() => void | Promise<void>)[] = []
beforeEach(resetFakeRuntime)
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
  vi.useRealTimers()
})

async function fixture(caps = [CAP_CONTEXT_OBSERVATION_V1, CAP_CONTEXT_READ_V1]) {
  const driver = createFakeServerDriver()
  const handle = await driver.create({
    harness: 'invented-context-harness',
    ...testSessionTerms(),
    harnessContext: testHarnessContext({ kind: 'codex' }),
    selection: { auth: 'api-key', platform: 'linux', available: ['fake'] },
    workdir: '/tmp/invented-context',
    model: {},
    instructions: unsupported('No hidden channel'),
    mcpServers: unsupported('No extension channel'),
  })
  releases.push(() => handle.kill())
  const sample = {
    id: 'invented-sample',
    at,
    bindingVersion: 1,
    observerGeneration: 1,
    turnEpoch: 0,
    contextRevision: 1,
    nativeSessionId: handle.binding.resume?.value,
  }
  const summary: Extract<ContextSummary, { status: 'available' }> = {
    version: 1,
    status: 'available',
    sample,
    model: { modelId: 'invented-observed-model' },
    occupancy: { basis: 'current-context', usedTokens: quantity(20) },
  }
  const detail: ContextDetailResult = {
    version: 1,
    status: 'available',
    sample,
    lastRequest: { input: quantity(20), output: quantity(10) },
  }
  driver.control.contextObservation(handle.binding.sessionId, summary, detail)
  const session = {
    machineId,
    driverId: handle.binding.driver,
    status: 'live',
    contextObservation: (await handle.snapshot()).context,
  }
  const frames: string[] = []
  const requests: RuntimeContextReadRequestMessage[] = []
  let connected = true
  let owned = true
  let currentHandle: typeof handle | undefined = handle
  let rpc: DaemonRpcService
  const mux = new DaemonMux({
    ports: {
      get rpc() {
        return rpc
      },
    } as unknown as DaemonFeaturePorts,
    bus: { emit: () => {} },
  })
  const daemon = {
    agentRuntime: {
      handleFor: (id: string) => (id === handle.binding.sessionId ? currentHandle : undefined),
      capabilitiesFor: () => driver.capabilities(),
    },
    send: (msg: DaemonMessage) => {
      if (msg.type !== 'runtimeContextReadResult') throw new Error('Unexpected read response')
      expect(DAEMON_FRAME_PORTS[msg.type]).toEqual(['rpc'])
      void mux.routeDaemonFrame(machineId, parseDaemonMessage(encodeDaemonMessage(msg)))
    },
  } as unknown as DaemonContext
  rpc = new DaemonRpcService({
    toMachine: (_id: unknown, msg: { type: string }) => {
      frames.push(msg.type)
      const parsed = parseControlMessage(JSON.stringify(msg))
      if (parsed.type === 'runtimeContextReadRequest') requests.push(parsed)
      dispatchControlMessage(daemon, parsed)
    },
    hasDaemon: () => connected,
    defaultMachine: () => machineId,
  } as never)
  const reads = new SessionContextReads({
    session: (id) => (id === handle.binding.sessionId ? session : undefined),
    connected: () => connected,
    supported: () => caps.includes(CAP_CONTEXT_READ_V1),
    read: (input, machine, signal) => rpc.contextRead(input, machine, signal),
  })
  releases.push(() => reads.dispose())
  const store = {
    sessions: { getSession: vi.fn(async () => (owned ? { ownerUserId: owner } : undefined)) },
  }
  const context = {
    registry: { sessionStore: store },
    modules: {
      sessions: { contextReads: reads, agentConcurrencyHistory: async () => ({ peak: 0 }) },
      machines: {},
    },
    capability: {
      role: 'member',
      scope: { kind: 'owned', userId: owner },
      actorUser: owner,
      onBehalfOf: owner,
    },
    principal: userCommandPrincipal(owner, 'member'),
  } as unknown as Context
  const router = t.router({
    sessions: t.router(
      queryProcedures('sessions', {
        contextRead: SESSION_QUERIES.contextRead,
        legacy: SESSION_QUERIES.concurrencyHistory,
      }),
    ),
  })
  const input: SessionContextReadInput = {
    sessionId: handle.binding.sessionId,
    read: { intent: 'breakdown', sample, timeoutMs: 1000, maxRows: 16 },
  }
  const invoke = (request = input, signal?: AbortSignal) =>
    router.createCaller(context, { signal }).sessions.contextRead(request)
  const native = vi.spyOn(handle.context!, 'detail')
  const cheap = vi.spyOn(handle.context!, 'summary')
  const send = vi.spyOn(handle, 'send')
  const create = vi.spyOn(driver, 'create')
  const resume = vi.spyOn(driver, 'resume')
  return {
    driver,
    handle,
    session,
    sample,
    summary,
    detail,
    frames,
    requests,
    mux,
    input,
    invoke,
    legacy: () => router.createCaller(context).sessions.legacy(),
    native,
    cheap,
    send,
    create,
    resume,
    store,
    reads,
    daemon,
    disconnect: () => {
      connected = false
    },
    deny: () => {
      owned = false
    },
    unbind: () => {
      currentHandle = undefined
    },
    async publish(next: Extract<ContextSummary, { status: 'available' }>) {
      driver.control.contextObservation(handle.binding.sessionId, next, {
        ...detail,
        sample: next.sample,
      })
      session.contextObservation = (await handle.snapshot()).context
    },
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('generic context request round trip with the reference driver', () => {
  it('does not let another RPC family settle the context read', async () => {
    const f = await fixture()
    const pending = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(pending.promise)
    const request = f.invoke()
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    const sent = f.requests[0]
    if (!sent) throw new Error('Expected the generic context request')
    await f.mux.routeDaemonFrame(machineId, {
      type: 'credentialRemoveResult',
      requestId: sent.requestId,
      outcome: 'absent',
    })
    pending.resolve(f.detail)
    expect(await request).toEqual({ intent: 'breakdown', result: f.detail })
  })
  it('never refreshes snapshots or summary probes when reading detail, including a lagging server sample', async () => {
    const f = await fixture()
    const snapshot = vi.spyOn(f.handle, 'snapshot').mockImplementation(() => {
      throw new Error('A snapshot would refresh native telemetry')
    })
    expect(await f.invoke()).toMatchObject({ result: { status: 'available' } })
    const next = { ...f.summary, sample: { ...f.sample, id: 'native-newer-than-server' } }
    f.driver.control.contextObservation(f.input.sessionId, next, {
      ...f.detail,
      sample: next.sample,
    })
    // The server still has the old pushed sample. The driver's cached detail
    // preflight must refuse it, rather than refreshing to discover it is old.
    expect(await f.invoke()).toMatchObject({ result: { status: 'superseded', sample: f.sample } })
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.cheap).not.toHaveBeenCalled()
  })
  it('keeps existing two-argument query handlers working through the signal conduit', async () => {
    const f = await fixture()
    expect(await f.legacy()).toEqual({ peak: 0 })
    expect(f.frames).toEqual([])
  })
  it('refuses a correlated answer naming a different session', async () => {
    const f = await fixture()
    const send = f.daemon.send
    vi.spyOn(f.daemon, 'send').mockImplementation((message) => {
      if (message.type === 'runtimeContextReadResult')
        send({ ...message, sessionId: asSessionId('another-session') })
      else send(message)
    })
    expect(await f.invoke()).toMatchObject({
      result: { status: 'refused', reason: { code: 'wrong-session' } },
    })
    expect(f.session.contextObservation?.context).toEqual(f.summary)
  })
  it('declines a bound summary-only driver before native detail IO', async () => {
    const f = await fixture()
    vi.spyOn(f.daemon.agentRuntime!, 'capabilitiesFor').mockReturnValue({
      ...f.driver.capabilities(),
      context: { supported: true, value: { summary: 'passive', detail: 'none' } },
    })
    expect(await f.invoke()).toMatchObject({ result: { status: 'unsupported' } })
    expect(f.native).not.toHaveBeenCalled()
  })
  it('routes explicit breakdown and cheap summary without generation, resume or summary replacement', async () => {
    const f = await fixture()
    const prior = f.session.contextObservation
    expect(await f.invoke()).toEqual({ intent: 'breakdown', result: f.detail })
    expect(f.native).toHaveBeenCalledOnce()
    expect(f.native.mock.calls[0]?.[0]).toMatchObject({
      sample: f.sample,
      timeoutMs: 1000,
      maxRows: 16,
    })
    expect(
      await f.invoke({
        sessionId: f.input.sessionId,
        read: { intent: 'summary', timeoutMs: 1000 },
      }),
    ).toMatchObject({
      intent: 'summary',
      result: { status: 'observation', observation: { context: f.summary } },
    })
    expect(f.cheap).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.session.contextObservation).toBe(prior)
    expect(f.frames).toEqual(['runtimeContextReadRequest', 'runtimeContextReadRequest'])
  })
  it('coalesces observers and releases one waiter without cancelling another', async () => {
    const f = await fixture()
    const pending = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const a = f.invoke(f.input, abort.signal)
    const b = f.invoke()
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    abort.abort()
    expect(await a).toMatchObject({ result: { status: 'cancelled', sample: f.sample } })
    expect(f.native.mock.calls[0]?.[0].signal?.aborted).toBe(false)
    pending.resolve(f.detail)
    expect(await b).toEqual({ intent: 'breakdown', result: f.detail })
    expect(f.frames).toEqual(['runtimeContextReadRequest'])
    expect(await f.invoke()).toEqual({ intent: 'breakdown', result: f.detail })
    expect(f.native).toHaveBeenCalledTimes(2) // Finished answers are not transport cache.
  })
  it('propagates last-owner cancellation through the query conduit and cancel frame', async () => {
    const f = await fixture()
    const pending = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const result = f.invoke(f.input, abort.signal)
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    abort.abort()
    expect(await result).toMatchObject({ result: { status: 'cancelled' } })
    await vi.waitFor(() => expect(f.native.mock.calls[0]?.[0].signal?.aborted).toBe(true))
    expect(f.frames).toContain('runtimeContextReadCancel')
    pending.resolve(f.detail)
    expect(f.session.contextObservation?.context).toEqual(f.summary)
  })
  it('separates later samples and discards an earlier late result', async () => {
    const f = await fixture()
    const old = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(old.promise)
    const a = f.invoke()
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    const next = { ...f.summary, sample: { ...f.sample, id: 'later-sample' } }
    await f.publish(next)
    const b = await f.invoke({
      ...f.input,
      read: { ...f.input.read, intent: 'breakdown', sample: next.sample, maxRows: 16 },
    })
    expect(b).toMatchObject({ result: { status: 'available', sample: next.sample } })
    old.resolve(f.detail)
    expect(await a).toMatchObject({ result: { status: 'cancelled', sample: f.sample } })
    expect(f.native).toHaveBeenCalledTimes(2)
    expect(f.session.contextObservation?.context).toEqual(next)
  })
  it.each([
    'new-summary',
    'model-change',
    'reset',
    'rebind',
    'disconnect',
  ] as const)('rejects an answer after %s without replacing the summary', async (boundary) => {
    const f = await fixture()
    const old = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(old.promise)
    const request = f.invoke()
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    if (boundary === 'new-summary')
      await f.publish({ ...f.summary, sample: { ...f.sample, id: 'later' } })
    if (boundary === 'model-change')
      await f.publish({ ...f.summary, model: { modelId: 'new-effective-model' } })
    if (boundary === 'reset') {
      f.driver.control.invalidateContext(f.input.sessionId, 'reset')
      f.session.contextObservation = (await f.handle.snapshot()).context
    }
    if (boundary === 'rebind') f.unbind()
    if (boundary === 'disconnect') f.disconnect()
    const prior = f.session.contextObservation
    old.resolve(f.detail)
    expect(await request).toMatchObject({
      result: { status: boundary === 'disconnect' ? 'unavailable' : 'superseded' },
    })
    expect(f.session.contextObservation).toBe(prior)
  })
  it('denies every observer before coalescing and reauthorizes after IO', async () => {
    const f = await fixture()
    const old = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(old.promise)
    const allowed = f.invoke()
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce())
    f.deny()
    expect(await f.invoke()).toMatchObject({
      result: { status: 'refused', reason: { code: 'unauthorized' } },
    })
    old.resolve(f.detail)
    expect(await allowed).toMatchObject({
      result: { status: 'refused', reason: { code: 'unauthorized' } },
    })
    expect(f.native).toHaveBeenCalledOnce()
  })
  it('settles old observation-only peers as unsupported without sending unknown frames', async () => {
    const f = await fixture([CAP_CONTEXT_OBSERVATION_V1])
    const prior = f.session.contextObservation
    expect(await f.invoke()).toMatchObject({
      result: { status: 'unsupported', reason: { code: 'unsupported-peer' } },
    })
    expect(f.frames).toEqual([])
    expect(f.native).not.toHaveBeenCalled()
    expect(f.session.contextObservation).toBe(prior)
  })
  it('preflights sample and bounded input before any native detail read', async () => {
    const f = await fixture()
    expect(
      await f.invoke({
        ...f.input,
        read: {
          ...f.input.read,
          intent: 'breakdown',
          sample: { ...f.sample, id: 'obsolete' },
          maxRows: 16,
        },
      }),
    ).toMatchObject({ result: { status: 'superseded' } })
    await expect(
      f.invoke({
        ...f.input,
        read: { ...f.input.read, intent: 'breakdown', sample: f.sample, maxRows: 129 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.native).not.toHaveBeenCalled()
    expect(f.frames).toEqual([])
  })
  it('refuses oversized normalized detail and permits a deliberate later retry', async () => {
    const f = await fixture()
    f.native.mockResolvedValueOnce({
      ...f.detail,
      lastRequest: { input: { ...quantity(20), source: 'x'.repeat(257) } },
    } as ContextDetailResult)
    expect(await f.invoke()).toMatchObject({
      result: { status: 'refused', reason: { code: 'invalid-response' } },
    })
    expect(await f.invoke()).toMatchObject({ result: { status: 'available' } })
    expect(f.session.contextObservation?.context).toEqual(f.summary)
  })
  it('bounds a nonresponding driver and aborts native work on timeout', async () => {
    const f = await fixture()
    const old = deferred<ContextDetailResult>()
    f.native.mockReturnValueOnce(old.promise)
    const result = f.invoke({ ...f.input, read: { ...f.input.read, timeoutMs: 40 } })
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce(), { interval: 1 })
    expect(await result).toMatchObject({
      result: { status: 'unavailable', reason: { code: 'timed-out' } },
    })
    await vi.waitFor(() => expect(f.native.mock.calls[0]?.[0].signal?.aborted).toBe(true))
    old.resolve(f.detail)
  })
  it('does not inspect or resume a dead headless/native process', async () => {
    const f = await fixture()
    vi.spyOn(f.handle, 'health').mockResolvedValue({ alive: false } as never)
    expect(await f.invoke()).toMatchObject({
      result: { status: 'unavailable', reason: { code: 'not-running' } },
    })
    expect(f.native).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  })
})
