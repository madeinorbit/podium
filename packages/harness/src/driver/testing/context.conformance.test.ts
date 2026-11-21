import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ContextDetailResult,
  type ContextSampleIdentity,
  type ContextSummary,
  contextUsagePercentOf,
} from '../../driver.js'
import { unsupported } from '../../manifest.js'
import { ContextObservationSchema, type ContextReader } from '../context.js'
import { SessionSnapshotSchema } from '../schemas.js'
import type { SessionSpec } from '../session-spec.js'
import { createFakeServerDriver, resetFakeRuntime } from './fake-driver.js'
import { testHarnessContext, testSessionTerms } from './harness-context.js'

const contextFor = (handle: { readonly context?: ContextReader }): ContextReader => {
  if (!handle.context)
    throw new Error('Synthetic driver failed to expose its declared context port')
  return handle.context
}

const q = (value: number, accuracy: 'reported' | 'estimated' = 'reported') => ({
  value,
  accuracy,
  source: 'synthetic native measurement',
})
const spec = (): SessionSpec => ({
  harness: 'invented-context-harness',
  ...testSessionTerms(),
  harnessContext: testHarnessContext({ kind: 'codex' }),
  selection: { auth: 'api-key', platform: 'linux', available: ['fake'] },
  workdir: '/tmp/context-fake',
  model: {},
  instructions: unsupported('No hidden instruction channel'),
  mcpServers: unsupported('No MCP servers'),
})
const sample = (): ContextSampleIdentity => ({
  id: 'primary-request-1',
  at: '2026-11-21T12:00:00.000Z',
  bindingVersion: 1,
  observerGeneration: 1,
  turnEpoch: 0,
  contextRevision: 1,
  nativeSessionId: 'native-primary',
})
const available = (): ContextSummary => ({
  version: 1,
  status: 'available',
  sample: sample(),
  model: { providerId: 'invented-provider', modelId: 'invented-model' },
  occupancy: { basis: 'current-context', usedTokens: q(20), percent: q(10) },
  effectiveCapacity: { ...q(200), basis: 'configured' },
})
const detail = (): ContextDetailResult => ({
  version: 1,
  status: 'available',
  sample: sample(),
  lastRequest: { input: q(20), cacheRead: q(5), output: q(10), reasoning: q(2) },
})

beforeEach(resetFakeRuntime)

describe('new synthetic harness context conformance', () => {
  it('replays the original sample and delivers explicit clears on a coarse-only stream', async () => {
    const driver = createFakeServerDriver()
    const handle = await driver.create(spec())
    const release = await handle.watch('coarse')
    driver.control.contextObservation(handle.binding.sessionId, available(), detail())
    const bootstrap = handle.events('bootstrap')[Symbol.asyncIterator]()
    await bootstrap.next() // Initial state.
    const replay = (await bootstrap.next()).value
    expect(replay).toMatchObject({
      t: 'metadata',
      provenance: 'bootstrap',
      change: { kind: 'context-observation', context: { sample: sample() } },
    })
    const cursor = (await handle.snapshot()).cursor
    const live = handle.events(cursor)[Symbol.asyncIterator]()
    const next = live.next()
    driver.control.invalidateContext(handle.binding.sessionId, 'compaction')
    expect((await next).value).toMatchObject({
      t: 'metadata',
      change: {
        kind: 'context-observation',
        context: { status: 'pending', invalidation: { cause: 'compaction' } },
      },
    })
    release()
    await bootstrap.return?.()
    await live.return?.()
    await handle.kill()
  })
  it.each([
    ['available', available()],
    [
      'estimated',
      { ...available(), occupancy: { basis: 'native-estimate', usedTokens: q(647, 'estimated') } },
    ],
    [
      'percentage-only',
      {
        ...available(),
        occupancy: { basis: 'current-context', percent: q(13) },
        effectiveCapacity: undefined,
      },
    ],
    [
      'count-only',
      {
        ...available(),
        occupancy: { basis: 'last-request', usedTokens: q(13_000) },
        effectiveCapacity: undefined,
      },
    ],
    [
      'pending',
      {
        version: 1,
        status: 'pending',
        revision: sample(),
        reason: { code: 'waiting', message: 'No response yet' },
      },
    ],
    [
      'unavailable',
      {
        version: 1,
        status: 'unavailable',
        revision: sample(),
        reason: { code: 'unbound', message: 'No exact native binding' },
      },
    ],
    [
      'stale',
      {
        ...available(),
        status: 'stale',
        reason: { code: 'offline', message: 'Native observer disconnected' },
      },
    ],
    [
      'unsupported',
      {
        version: 1,
        status: 'unsupported',
        reason: { code: 'no-channel', message: 'No validated native channel exists' },
      },
    ],
  ] as const)('reads %s data through the same consumer port', async (_name, summary) => {
    const driver = createFakeServerDriver({ harness: 'invented-context-harness' })
    const handle = await driver.create(spec())
    const normalized = ContextObservationSchema.parse({
      at: sample().at,
      provenance: 'live',
      cursor: { segmentId: 'synthetic', components: { seq: 1 } },
      observerGeneration: 1,
      turnEpoch: 0,
      context: summary,
    }).context
    driver.control.contextObservation(handle.binding.sessionId, normalized)
    const reading = await contextFor(handle).summary({ timeoutMs: 500 })
    expect(reading.status).toBe('observation')
    if (reading.status !== 'observation') throw new Error('Expected a context observation')
    expect(reading.observation.context).toEqual(normalized)
    expect(SessionSnapshotSchema.parse(await handle.snapshot()).context).toEqual(
      reading.observation,
    )
    expect(driver.capabilities().context).toMatchObject({ supported: true })
    expect(contextUsagePercentOf(reading.observation.context)).toBe(
      contextUsagePercentOf(normalized),
    )
    await handle.kill()
  })
  it('summary refresh preserves sample identity and only describes that sample on demand', async () => {
    const driver = createFakeServerDriver({ harness: 'another-new-harness' })
    const handle = await driver.create(spec())
    driver.control.contextObservation(handle.binding.sessionId, available(), detail())
    const first = await contextFor(handle).summary({ timeoutMs: 500 })
    expect(await contextFor(handle).summary({ timeoutMs: 500 })).toEqual(first)
    const request = { sample: sample(), timeoutMs: 500, maxRows: 16 }
    expect(await contextFor(handle).detail(request)).toEqual(detail())
    expect(
      await contextFor(handle).detail({
        ...request,
        sample: { ...sample(), id: 'different-sample' },
      }),
    ).toMatchObject({ status: 'superseded' })
    expect(
      await contextFor(handle).detail({ ...request, signal: AbortSignal.abort() }),
    ).toMatchObject({ status: 'cancelled', sample: sample() })
    expect(await contextFor(handle).detail({ ...request, maxRows: 129 })).toMatchObject({
      status: 'refused',
    })
    expect(await contextFor(handle).summary({ timeoutMs: 0 })).toMatchObject({ status: 'refused' })
    expect(
      await contextFor(handle).summary({ timeoutMs: 500, signal: AbortSignal.abort() }),
    ).toMatchObject({ status: 'cancelled' })
    await handle.kill()
  })
  it('requested model settings do not relabel a native sample', async () => {
    const driver = createFakeServerDriver()
    const handle = await driver.create(spec())
    driver.control.contextObservation(handle.binding.sessionId, available(), detail())
    await handle.configure({ model: 'requested-next-model' })
    expect((await handle.snapshot()).context?.context).toHaveProperty(
      'model.modelId',
      'invented-model',
    )
    driver.control.invalidateContext(handle.binding.sessionId, 'model-changed')
    expect((await handle.snapshot()).context?.context).toMatchObject({
      status: 'pending',
      invalidation: { cause: 'model-changed' },
    })
    expect(
      await contextFor(handle).detail({ sample: sample(), timeoutMs: 500, maxRows: 16 }),
    ).toMatchObject({ status: 'superseded' })
    await handle.kill()
  })
  it('adoption replaces old-generation samples with an explicit resume invalidation', async () => {
    const driver = createFakeServerDriver()
    const handle = await driver.create(spec())
    driver.control.contextObservation(handle.binding.sessionId, available(), detail())
    const rebound = await driver.adopt(handle.binding)
    expect((await rebound.snapshot()).context?.context).toMatchObject({
      status: 'pending',
      revision: { bindingVersion: 2, observerGeneration: 2, contextRevision: 2 },
      invalidation: { cause: 'resume', previousSample: sample() },
    })
    expect(
      await contextFor(rebound).detail({ sample: sample(), timeoutMs: 500, maxRows: 16 }),
    ).toMatchObject({ status: 'superseded' })
    await rebound.kill()
  })
})
