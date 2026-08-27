import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { PERMITTED_FAILURES } from '../../permitted-failures.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { defaultAskFor, runConformance } from '../../testing/index.js'
import {
  createClaudeSdkRuntime,
  type ClaudeSdkRuntime,
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
} from './runtime.js'

interface PendingTurn {
  resumeValue: string
  itemId: string
  text: string
  interrupted: boolean
  disposed: boolean
  onPartialText(text: string, itemHint?: string): void
  resolve(value: { resumeValue: string; output: string; itemId: string }): void
  reject(error: Error): void
}

function makeWorld(): {
  target: ConformanceTarget
  children: PendingTurn[]
  starts: boolean[]
  cleanup(): void
} {
  let runtime: ClaudeSdkRuntime | undefined
  let seq = 0
  let failNextStart = false
  const pending = new Map<SessionId, PendingTurn>()
  const conversations = new Map<string, TranscriptItem[]>()
  const children: PendingTurn[] = []
  const starts: boolean[] = []
  const stamp = () => new Date(Date.UTC(2026, 7, 27) + ++seq * 1000).toISOString()

  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => `claude-sdk-session-${++seq}` as SessionId,
    mintResumeValue: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    now: stamp,
    startTurn(input): ClaudeSdkTurnHandle {
      starts.push(input.newConversation)
      if (failNextStart) {
        failNextStart = false
        throw new Error('fixture refused the SDK callback')
      }
      const stored = conversations.get(input.resumeValue) ?? []
      stored.push({
        id: `user-${input.resumeValue}-${stored.length + 1}`,
        role: 'user',
        text: input.turn.text,
        ts: stamp(),
      })
      conversations.set(input.resumeValue, stored)
      let resolve!: PendingTurn['resolve']
      let reject!: PendingTurn['reject']
      const done = new Promise<{ resumeValue: string; output: string; itemId: string }>(
        (res, rej) => {
          resolve = res
          reject = rej
        },
      )
      const turn: PendingTurn = {
        resumeValue: input.resumeValue,
        itemId: `assistant-${input.resumeValue}-${stored.length + 1}`,
        text: '',
        interrupted: false,
        disposed: false,
        onPartialText: input.onPartialText,
        resolve,
        reject,
      }
      children.push(turn)
      pending.set(input.sessionId, turn)
      return {
        done,
        interrupt() {
          turn.interrupted = true
        },
        answerPermission() {},
        dispose() {
          turn.disposed = true
        },
      }
    },
    async readTranscript({ resumeValue, limit }) {
      return (conversations.get(resumeValue) ?? []).slice(-limit)
    },
    async readArchive({ resumeValue }) {
      const items = conversations.get(resumeValue) ?? []
      if (items.length === 0) return undefined
      return {
        path: `${resumeValue}.jsonl`,
        bytes: new TextEncoder().encode(items.map((item) => JSON.stringify(item)).join('\n')),
      }
    },
  }

  const control: ConformanceControl = {
    askInteraction(sessionId, spec) {
      if (!runtime) throw new Error('runtime not created')
      return runtime.testInteractionRequested(
        sessionId,
        typeof spec === 'string' ? defaultAskFor(spec) : spec,
      )
    },
    reaskInteraction(sessionId) {
      return control.askInteraction(sessionId, 'permission')
    },
    async completeTurn(sessionId) {
      const turn = pending.get(sessionId)
      if (!turn) return
      const text = turn.text || 'fixture reply'
      const item: TranscriptItem = {
        id: turn.itemId,
        role: 'assistant',
        text,
        ts: stamp(),
      }
      const stored = conversations.get(turn.resumeValue) ?? []
      stored.push(item)
      conversations.set(turn.resumeValue, stored)
      pending.delete(sessionId)
      turn.resolve({ resumeValue: turn.resumeValue, output: text, itemId: turn.itemId })
      await Promise.resolve()
    },
    async failTurn(sessionId) {
      const turn = pending.get(sessionId)
      if (!turn) return
      pending.delete(sessionId)
      turn.reject(new Error('provider-error'))
      await Promise.resolve()
    },
    async streamAssistantText(sessionId, chunks) {
      const turn = pending.get(sessionId)
      if (!turn) return
      for (const chunk of chunks) {
        turn.text += chunk
        turn.onPartialText(turn.text, turn.itemId)
      }
      await Promise.resolve()
    },
    processEvent(sessionId, event) {
      runtime?.processEvent(sessionId, event)
    },
    failNextVerification() {
      failNextStart = true
    },
    textDeliveries(sessionId) {
      return runtime?.textDeliveries(sessionId) ?? 0
    },
    model: {
      policy: () => ({ model: 'claude-sonnet-4-5', effort: 'high' }),
      requested: (sessionId) => runtime?.requestedModel(sessionId),
    },
    restartSupervisor() {
      runtime?.restartSupervisor()
    },
    connectWithoutSecret() {
      return { refused: false }
    },
  }

  const target: ConformanceTarget = {
    name: 'claude-sdk',
    family: 'embedded',
    createDriver() {
      runtime = createClaudeSdkRuntime(host)
      return { driver: runtime, control }
    },
    reset() {
      runtime?.dispose()
      runtime = undefined
      for (const turn of pending.values()) turn.reject(new Error('fixture reset'))
      pending.clear()
      conversations.clear()
      children.length = 0
      starts.length = 0
      failNextStart = false
      seq = 0
    },
    spec: () => ({
      harness: 'claude-code',
      selection: {
        auth: 'api-key',
        platform: 'linux',
        available: ['claude-sdk'],
        preference: 'claude-sdk',
      },
      workdir: '/tmp/claude-sdk-conformance',
      model: { model: 'claude-sonnet-4-5', effort: 'high' },
      instructions: { supported: false, reason: 'fixture' },
      mcpServers: { supported: false, reason: 'fixture' },
    }),
  }
  return { target, children, starts, cleanup: target.reset }
}

const world = makeWorld()
runConformance(world.target.createDriver, {
  name: world.target.name,
  family: world.target.family,
  reset: world.target.reset,
  spec: world.target.spec,
  exemptions: PERMITTED_FAILURES.embedded,
})

describe('claude-sdk conversation persistence', () => {
  it('mints the first SDK session and resumes it for every later turn', async () => {
    const local = makeWorld()
    const { driver, control } = local.target.createDriver()
    const session = await driver.create(local.target.spec())
    await session.send({ text: 'first' }, { origin: 'human', delivery: 'when-ready' })
    await control.completeTurn(session.binding.sessionId)
    await session.send({ text: 'second' }, { origin: 'human', delivery: 'when-ready' })
    await control.completeTurn(session.binding.sessionId)
    expect(local.starts).toEqual([true, false])

    const resume = session.binding.resume
    if (!resume) throw new Error('fixture did not mint a Claude resume ref')
    await session.kill()
    const resumed = await driver.resume(resume, local.target.spec())
    await resumed.send({ text: 'third' }, { origin: 'human', delivery: 'when-ready' })
    expect(local.starts.at(-1)).toBe(false)
    local.cleanup()
  })
})
describe('claude-sdk lifecycle cleanup', () => {
  it('interrupts and disposes an in-flight process-per-turn child on kill', async () => {
    const local = makeWorld()
    const { driver } = local.target.createDriver()
    const session = await driver.create(local.target.spec())
    await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
    const child = local.children.at(-1)
    await session.kill()
    expect(await session.health()).toMatchObject({ alive: false })
    expect(child).toMatchObject({ interrupted: true, disposed: true })
    local.cleanup()
  })
})
