import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unsupported } from '../../../manifest.js'
import {
  contextFixtureAt,
  contextFixtureCausal,
  installContextFixture,
} from '../../testing/context-fixture.js'
import { createMemoryDriverSlots } from '../../testing/driver-slots.js'
import { testHarnessContext, testSessionTerms } from '../../testing/harness-context.js'
import { createHeadlessRuntime, type HeadlessDriverHost } from './runtime.js'

const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})

describe('headless context resume without another process', () => {
  it('recovers an attributable raw replay and fences a later binding without spawning on snapshot or summary', async () => {
    const adapter = installContextFixture()
    releases.push(adapter.release)
    const runTurn = vi.fn(() => {
      throw new Error('A context read must never launch a turn')
    })
    const bindHeadlessSession = vi.fn()
    const runtime = createHeadlessRuntime(
      {
        send: vi.fn(),
        now: () => Date.parse(contextFixtureAt),
        durableLabel: () => 'invented-headless-host',
        bindHeadlessSession,
      } as unknown as HeadlessDriverHost,
      createMemoryDriverSlots(),
      { runTurn, acknowledge: vi.fn() },
    )
    releases.push(() => runtime.dispose())
    const sessionId = asSessionId('invented-headless-recovery')
    const spec = {
      harness: 'fixture',
      ...testSessionTerms(),
      harnessContext: testHarnessContext({ kind: 'codex' }),
      selection: { auth: 'unknown' as const, platform: 'linux' as const, available: [] },
      workdir: '/tmp/invented-headless',
      model: {},
      instructions: unsupported('No hidden instructions'),
      mcpServers: unsupported('No MCP in the invented protocol'),
    }
    const handle = await runtime.resumeWithId(
      sessionId,
      { kind: 'claude-session', value: 'invented-primary' },
      spec,
    )
    expect((await handle.snapshot()).context?.context.status).toBe('pending')
    const causal = { ...contextFixtureCausal(10), provenance: 'bootstrap' as const }
    runtime.observeContextPayload(
      sessionId,
      { id: 'native-prior-turn', percent: 25, nativeSessionId: 'invented-primary' },
      causal,
    )
    const snapshot = await handle.snapshot()
    expect(snapshot.context).toMatchObject({
      ...causal,
      context: { status: 'available', sample: { id: 'native-prior-turn', at: contextFixtureAt } },
    })
    expect(await handle.context?.summary({ timeoutMs: 100 })).toEqual({
      status: 'observation',
      observation: snapshot.context,
    })
    await runtime.resumeWithId(
      sessionId,
      { kind: 'claude-session', value: 'another-primary' },
      spec,
    )
    expect((await handle.snapshot()).context?.context).toMatchObject({
      status: 'pending',
      revision: { bindingVersion: 2, observerGeneration: 2 },
    })
    runtime.observeContextPayload(sessionId, { id: 'late-old-binding', percent: 99 }, causal)
    expect((await handle.snapshot()).context?.context.status).toBe('pending')
    expect(runTurn).not.toHaveBeenCalled()
    expect(bindHeadlessSession).toHaveBeenCalledTimes(2)
  })
})
