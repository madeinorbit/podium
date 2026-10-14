/**
 * OPENCODE'S `question` TOOL UNDER THE SEAT RULE (POD-6108, ANALYSIS.md D5).
 *
 * OpenCode 1.18.35 always offers `question`; a reject ends the turn and drops any
 * text, while a reply reaches the model as the answer (RUN with a fake model
 * server, 2026-10-14). So a session below a coordinator is answered with the
 * refusal, which names where to ask; any other session's question opens as usual.
 */

import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import type { AskUserGate } from '../ask-user-gate.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/ask-user-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

const QUESTIONS = [
  { question: 'Which way?', header: 'Way', options: [{ label: 'Left', description: 'go left' }] },
  { question: 'How fast?', header: 'Speed', options: [{ label: 'Slow', description: 'slowly' }] },
]

async function askOnce(gate: AskUserGate) {
  const host = makeOpencodeTestHost()
  const runtime = createOpencodeRuntime({ ...host, askUserGate: gate }, createMemoryDriverSlots())
  const handle = await runtime.driver.create(spec())
  const server = host.serverFor(handle.binding.sessionId)!
  const opencodeId = host.bindings.recorded(handle.binding.sessionId)?.opencodeSessionId ?? ''
  expect(opencodeId).not.toBe('')
  const requestId = server.askQuestion({ sessionID: opencodeId, questions: QUESTIONS })
  return { runtime, handle, server, requestId }
}

describe('OpenCode question under the seat rule', () => {
  it('answers every question with the refusal for a session below a coordinator', async () => {
    const { runtime, server, requestId } = await askOnce(async () => 'Ask POD-7 instead')
    try {
      await expect
        .poll(() => server.questionReplies, { timeout: 5000 })
        .toEqual([{ requestId, answers: [['Ask POD-7 instead'], ['Ask POD-7 instead']] }])
    } finally {
      runtime.dispose()
    }
  })

  it('opens the question for a session that may talk to the user', async () => {
    const { runtime, handle, server } = await askOnce(async () => null)
    try {
      await expect.poll(async () => (await handle.interactions()).length, { timeout: 5000 }).toBe(1)
      expect(server.questionReplies).toEqual([])
    } finally {
      runtime.dispose()
    }
  })
})
