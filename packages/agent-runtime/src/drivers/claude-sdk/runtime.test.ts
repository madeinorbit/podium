import type { SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
  createClaudeSdkRuntime,
} from './runtime.js'

const SESSION = 'claude-sdk-durable' as SessionId

function spec() {
  return {
    harness: 'claude-code' as const,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-durable',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

function hostWith(fail: (message: string) => Error): {
  host: ClaudeSdkRuntimeHost
  resumeValue: string
} {
  const resumeValue = '00000000-0000-4000-8000-000000000001'
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => SESSION,
    mintResumeValue: () => resumeValue,
    now: () => '2026-08-28T00:00:00.000Z',
    startTurn(): ClaudeSdkTurnHandle {
      return {
        done: Promise.reject(fail('turn')),
        interrupt() {},
        answerPermission() {},
        dispose() {},
      }
    },
    async readTranscript() {
      return []
    },
    async readArchive() {
      return undefined
    },
  }
  return { host, resumeValue }
}

async function settledState(runtime: ReturnType<typeof createClaudeSdkRuntime>) {
  const handle = runtime.handleFor(SESSION)
  if (!handle) throw new Error('missing handle')
  await vi.waitFor(async () => {
    const state = await handle.state()
    expect(state.phase).toBe('errored')
  })
  return handle
}

describe('Claude SDK durable failure state', () => {
  it('records monthly spend as usage_limit and keeps the resume binding', async () => {
    const { host, resumeValue } = hostWith(
      () => new Error("You've hit your monthly spend limit CLAUDE_CODE_OAUTH_TOKEN=oat_secret"),
    )
    const runtime = createClaudeSdkRuntime(host)
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: {
        class: 'usage_limit',
        retryable: false,
        detail: expect.stringMatching(/monthly spend limit/i),
      },
    })
    const state = await settled.state()
    expect(state.error?.detail).not.toMatch(/oat_secret/)
    expect(settled.binding.resume).toEqual({ kind: 'claude-session', value: resumeValue })
    runtime.dispose()
  })

  it('records expired auth as authentication, distinct from spend exhaustion', async () => {
    const { host } = hostWith(() => new Error('401 Unauthorized — access token is expired'))
    const runtime = createClaudeSdkRuntime(host)
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: { class: 'authentication', retryable: false },
    })
    runtime.dispose()
  })
})
