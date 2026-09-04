import type { SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../index.js'
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

async function eventsThroughFailed(
  runtime: ReturnType<typeof createClaudeSdkRuntime>,
): Promise<RuntimeEvent[]> {
  const handle = await settledState(runtime)
  const events: RuntimeEvent[] = []
  for await (const event of handle.events('bootstrap')) {
    events.push(event)
    if (event.t === 'turn' && event.ev.ev === 'failed') break
  }
  return events
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

  it('records a dead SDK host as host_death, distinct from auth and quota', async () => {
    const { host } = hostWith(
      () => new Error('the Claude model host process exited with code 1 before the turn finished'),
    )
    const runtime = createClaudeSdkRuntime(host)
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const settled = await settledState(runtime)
    await expect(settled.state()).resolves.toMatchObject({
      phase: 'errored',
      error: { class: 'host_death', retryable: true },
    })
    runtime.dispose()
  })

  it('publishes the prompt and classified error onto the transcript before closing the turn', async () => {
    const { host } = hostWith(() => new Error('not logged in — run /login'))
    const runtime = createClaudeSdkRuntime(host)
    const handle = await runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'ping' }, { origin: 'human', delivery: 'when-ready' })
    const events = await eventsThroughFailed(runtime)
    const kinds: string[] = []
    const items: { role: string; text: string }[] = []
    for (const event of events) {
      if (event.t === 'turn' && (event.ev.ev === 'failed' || event.ev.ev === 'started')) {
        kinds.push(`turn:${event.ev.ev}`)
        continue
      }
      if (event.t === 'state' && event.change.kind === 'turn_failed') {
        kinds.push('state:turn_failed')
        continue
      }
      if (event.t === 'item' && event.item.kind === 'complete') {
        kinds.push(`item:${event.item.item.role}`)
        items.push(event.item.item)
      }
    }
    expect(items).toEqual([
      expect.objectContaining({ role: 'user', text: 'ping' }),
      expect.objectContaining({
        role: 'system',
        text: expect.stringMatching(/Provider authentication failed/i),
      }),
    ])
    const failed = events.find((event) => event.t === 'state' && event.change.kind === 'turn_failed')
    expect(failed).toMatchObject({
      t: 'state',
      change: { kind: 'turn_failed', errorClass: 'authentication', retryable: false },
    })
    runtime.dispose()
  })
})
