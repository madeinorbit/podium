import { asSessionId, ContextSummary, contextUsagePercentOf } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding } from '../../driver/binding.js'
import { RuntimeContextRelay } from '../../driver/context-relay.js'
import type { SessionMetadataObservation } from '../../driver/events.js'
import {
  contextFixtureCausal,
  installContextFixture,
} from '../../driver/testing/context-fixture.js'
import { DRIVER_IDS } from '../../manifest.js'
import { contextCapabilityFor, contextStrategyFor } from '../../registry.js'
import fixtures from './__fixtures__/context-2026.07.23-e383d2b.json'
import { cursorContext } from './context.js'
import { cursorManifest } from './index.js'

const modes = ['generic-pty', 'headless'] as const

function relayFor(harness: string, driver: SessionBinding['driver']) {
  let binding: SessionBinding = {
    sessionId: asSessionId('cursor-context-fixture'),
    harness,
    driver,
    family: driver === 'headless' ? 'server' : 'terminal',
    workdir: '/fixture/workspace',
    resume: { kind: 'cursor-chat', value: 'invented-primary' },
    process: { key: 'fixture-process' },
    bindingVersion: 1,
  }
  const request = vi.fn(async () => {
    throw new Error('A declined context adapter must not probe native state')
  })
  const emitted: SessionMetadataObservation[] = []
  let seq = 1
  let generation = 1
  const relay = new RuntimeContextRelay({
    binding: () => binding,
    causal: () => contextFixtureCausal(seq++, generation),
    probe: { request },
    emit: (event) => emitted.push(event),
  })
  return {
    relay,
    request,
    emitted,
    rebind() {
      binding = { ...binding, bindingVersion: binding.bindingVersion + 1 }
      generation++
    },
  }
}

function unsupportedSummary(driver: (typeof modes)[number]) {
  const declaration = cursorContext.forDriver(driver)
  if (declaration.supported) throw new Error('Current Cursor output has no verified context source')
  return {
    version: 1,
    status: 'unsupported',
    reason: { code: 'no-channel', message: declaration.reason },
  } as const
}

describe('Cursor context source admission', () => {
  it('records the exact admitted build and limits of the source evidence', () => {
    expect(fixtures.cursorAgentVersion).toBe('2026.07.23-e383d2b')
    expect(fixtures.sources['accepted-r6'].version).toBe(fixtures.cursorAgentVersion)
    expect(fixtures.sources['print-error'].version).toBe(fixtures.cursorAgentVersion)
    expect(fixtures.sources['accepted-r6'].limit).toContain('No completed')
    expect(fixtures.sources['output-docs'].reference).toBe(
      'https://cursor.com/docs/cli/reference/output-format',
    )
    for (const entry of fixtures.cases) expect(fixtures.sources).toHaveProperty(entry.source)
  })

  it.each(
    modes,
  )('declares %s unsupported with an explanation, not a waiting strategy', (driver) => {
    expect(cursorManifest.runtime.context).toBe(cursorContext)
    const declaration = contextStrategyFor('cursor', driver)
    expect(declaration.supported).toBe(false)
    if (declaration.supported) throw new Error('Unexpected Cursor context implementation')
    expect(declaration.reason).toMatch(/current-context usage/)
    expect(declaration.reason).toMatch(/capacity/)
    expect(contextCapabilityFor('cursor', driver)).toEqual(declaration)
    expect(fixtures.outcomes[driver]).toBe('unsupported')
  })

  it.each(DRIVER_IDS)('has a reasoned declaration for every mechanism: %s', (driver) => {
    const declaration = cursorContext.forDriver(driver)
    expect(declaration.supported).toBe(false)
    if (!declaration.supported) expect(declaration.reason.trim().length).toBeGreaterThan(0)
  })

  describe.each(modes)('%s negative fixtures', (driver) => {
    it.each(fixtures.cases)('$id cannot create a sample', async ({ payload }) => {
      const f = relayFor('cursor', driver)
      try {
        f.relay.observe(payload, contextFixtureCausal(10))
        const reading = await f.relay.reader.summary({ timeoutMs: 100 })
        expect(reading).toMatchObject({ status: 'observation' })
        if (reading.status !== 'observation') throw new Error('Expected a reasoned decline')
        const context = ContextSummary.parse(reading.observation.context)
        // Whole equality excludes sample, model, occupancy, capacities and accounting.
        expect(context).toEqual(unsupportedSummary(driver))
        expect(contextUsagePercentOf(context)).toBeUndefined()
        expect(f.relay.snapshot()?.context).toEqual(context)
        expect(await f.relay.replay()).toEqual(reading.observation)
        expect(f.emitted).toEqual([])
        expect(f.request).not.toHaveBeenCalled()
      } finally {
        f.relay.dispose()
      }
    })

    it('does not infer a sample from transcript count, visible length or context-looking fields', () => {
      const f = relayFor('cursor', driver)
      try {
        for (let seq = 1; seq <= 50; seq++) {
          f.relay.observe(
            {
              role: 'assistant',
              message: { content: [{ type: 'text', text: 'visible '.repeat(200) }] },
              context: { usedTokens: 0, totalTokens: 200000, ratio: 0 },
              usage: { input_tokens: 100, output_tokens: 20 },
            },
            contextFixtureCausal(seq),
          )
        }
        expect(f.relay.snapshot()?.context).toEqual(unsupportedSummary(driver))
        expect(f.request).not.toHaveBeenCalled()
      } finally {
        f.relay.dispose()
      }
    })

    it('keeps a permanent decline distinct from no sample, unknown model and disconnection', () => {
      const f = relayFor('cursor', driver)
      try {
        f.relay.snapshot()
        f.relay.lost(contextFixtureCausal(10))
        f.relay.invalidate('model-changed', contextFixtureCausal(11))
        f.relay.invalidate('compaction', contextFixtureCausal(12))
        expect(f.relay.snapshot()?.context).toEqual(unsupportedSummary(driver))
        f.rebind()
        expect(f.relay.snapshot()).toMatchObject({
          observerGeneration: 2,
          context: unsupportedSummary(driver),
        })
        expect(f.relay.snapshot()?.context).toEqual(unsupportedSummary(driver))
        expect(f.request).not.toHaveBeenCalled()
      } finally {
        f.relay.dispose()
      }
    })
  })

  it.each(
    modes,
  )('a future verified %s source can use the same generic consumer', async (driver) => {
    // The shared invented adapter is the replacement seam, not Cursor telemetry.
    const adapter = installContextFixture()
    const f = relayFor('fixture', driver)
    try {
      expect(contextCapabilityFor('fixture', driver)).toMatchObject({ supported: true })
      expect(f.relay.snapshot()?.context.status).toBe('pending')
      f.relay.observe(
        { id: 'verified-fixture-reading', nativeSessionId: 'invented-primary', percent: 37 },
        contextFixtureCausal(10),
      )
      const reading = await f.relay.reader.summary({ timeoutMs: 100 })
      if (reading.status !== 'observation') throw new Error('Expected an invented reading')
      expect(reading.observation.context).toMatchObject({
        status: 'available',
        occupancy: { percent: { value: 37 } },
      })
      expect(contextUsagePercentOf(reading.observation.context)).toBe(37)
      f.relay.lost(contextFixtureCausal(11))
      expect(f.relay.snapshot()?.context).toMatchObject({
        status: 'stale',
        sample: { id: 'verified-fixture-reading' },
      })
      f.relay.invalidate('model-changed', contextFixtureCausal(12))
      const cleared = f.relay.snapshot()?.context
      expect(cleared?.status).toBe('pending')
      if (cleared?.status !== 'pending') throw new Error('Expected an explicit clear')
      adapter.bindings[0]?.publish({
        ...contextFixtureCausal(13),
        context: {
          version: 1,
          status: 'unavailable',
          revision: cleared.revision,
          reason: {
            code: 'unknown-model',
            message: 'The invented source cannot identify its model',
          },
        },
      })
      expect(f.relay.snapshot()?.context).toMatchObject({
        status: 'unavailable',
        reason: { code: 'unknown-model' },
      })
      expect(contextCapabilityFor('fixture', driver)).toMatchObject({ supported: true })
      expect(contextCapabilityFor('cursor', driver)).toMatchObject({ supported: false })
      expect(f.request).not.toHaveBeenCalled()
    } finally {
      f.relay.dispose()
      adapter.release()
    }
  })
})
