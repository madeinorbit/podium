import { describe, expect, it, vi } from 'vitest'
import { testAccount, testHarnessContext } from '../../driver/testing/harness-context.js'
import type { HarnessObserveInput, HarnessObserverHost } from '../../manifest.js'
import { CODEX_INVOCATION, codexInvocationPublisher } from './context-invocation.js'

const spawn = Date.parse('2026-11-21T22:12:39.800Z')
function setup(overrides: Partial<HarnessObserveInput> = {}) {
  let generation = 2
  let turnEpoch = 1
  const onContextPayload = vi.fn()
  const input: HarnessObserveInput = {
    cwd: '/work/fixture',
    account: testAccount('codex', '/home/podium-test'),
    startedAtMs: spawn,
    harnessContext: testHarnessContext({ kind: 'codex', version: 'codex-cli 0.169.0' }),
    ...overrides,
  }
  const host = {
    contextIdentity: () => ({ observerGeneration: generation, turnEpoch }),
    onContextPayload,
  } as unknown as HarnessObserverHost
  return {
    publish: codexInvocationPublisher(input, host),
    onContextPayload,
    nextTurn: () => turnEpoch++,
    nextGeneration: () => generation++,
  }
}

describe('Codex invocation version witness', () => {
  it('uses only a pinned fresh-spawn context and the current admitted generation', () => {
    const w = setup()
    w.publish('native-main')
    w.publish('native-main')
    expect(w.onContextPayload).toHaveBeenCalledTimes(1)
    expect(w.onContextPayload).toHaveBeenCalledWith(
      {
        type: CODEX_INVOCATION,
        nativeSessionId: 'native-main',
        version: '0.169.0',
        startedAt: '2026-11-21T22:12:39.800Z',
      },
      {
        at: '2026-11-21T22:12:39.800Z',
        provenance: 'live',
        observerGeneration: 2,
        turnEpoch: 1,
        cursor: { segmentId: 'codex-invocation', components: { spawn } },
      },
    )
    w.nextTurn()
    w.publish('native-main')
    w.nextGeneration()
    w.publish('native-main')
    expect(w.onContextPayload).toHaveBeenCalledTimes(3)
  })

  it('does not promote rebuilt reattach inventory or createdAtMs into invocation proof', () => {
    const w = setup({ startedAtMs: undefined, createdAtMs: spawn })
    w.publish('native-main')
    expect(w.onContextPayload).not.toHaveBeenCalled()
    const missing = setup({ harnessContext: undefined })
    missing.publish('native-main')
    expect(missing.onContextPayload).not.toHaveBeenCalled()
  })
})
