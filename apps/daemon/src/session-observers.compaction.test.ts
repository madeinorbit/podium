import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptAgentObservation,
  agentStateProviderFor,
  captureClaudeTranscript,
  claudeTranscriptSegmentId,
} from '@podium/harness'
import { asSessionId } from '@podium/model'
import type { AgentObservation, SessionObservationCheckpointV1 } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { createSessionObservers } from './session-observers'

const at = '2026-10-30T14:30:56.211Z'
const record = (value: unknown) => `${JSON.stringify(value)}\n`
const prompt = (content: string) =>
  record({ type: 'user', timestamp: at, message: { role: 'user', content } })
const finished = record({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Done.' }],
  },
})

describe('Claude compaction rebuild [POD-2275]', () => {
  for (const summaryBytes of [200, 150_000]) {
    it.each([
      'idle',
      'working',
      'waiting',
      'compacting_working',
      'compacting_waiting',
      'tool_use',
      'tool_result',
      'question',
      'error',
      'lost_stop',
      'interrupt',
      'next_prompt',
    ] as const)(`rebuilds %s across a ${summaryBytes}-byte compaction summary`, async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), 'podium-compaction-rebuild-'))
      const path = join(dir, 'claude-1.jsonl')
      const sessionId = asSessionId('compaction-session')
      const sent: AgentObservation[] = []
      const observers = createSessionObservers({
        send(message: DaemonMessage) {
          if (message.type === 'agentObservation') sent.push(message.observation)
        },
        onTranscriptDirty: vi.fn(),
        cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      })
      try {
        const waiting = scenario === 'waiting' || scenario === 'compacting_waiting'
        const compacting = scenario === 'compacting_working' || scenario === 'compacting_waiting'
        const need = { kind: 'question' as const, summary: 'Which option?' }
        const accepted = prompt('finish the task') + (scenario === 'idle' ? finished : '')
        await writeFile(path, accepted)
        const identity = await captureClaudeTranscript(path)
        const cursor = {
          segmentId: claudeTranscriptSegmentId('claude-1', identity),
          components: { transcript: Buffer.byteLength(accepted), hook: 9 },
        }
        const checkpoint: SessionObservationCheckpointV1 = {
          schemaVersion: 1,
          podiumSessionId: sessionId,
          provider: 'claude-code',
          providerSessionId: 'claude-1',
          bindingVersion: 2,
          lifecycleObservationGeneration: 7,
          providerCursor: cursor,
          bootstrapCursor: cursor,
          lastAcceptedLiveCursor: cursor,
          turnEpoch: 5,
          providerTurnId: null,
          providerPromptId: 'prompt-5',
          turnState: {
            phase: compacting
              ? 'compacting'
              : waiting
                ? 'needs_user'
                : scenario === 'idle'
                  ? 'idle'
                  : 'working',
            ...(scenario === 'idle' ? { idle: { kind: 'done' as const } } : {}),
            ...(waiting && !compacting ? { need } : {}),
            ...(compacting
              ? {
                  compactingFrom: {
                    phase: waiting ? ('needs_user' as const) : ('working' as const),
                    ...(waiting ? { need } : {}),
                  },
                }
              : {}),
            since: at,
            workingMsTotal: 920_171,
            nativeSubagentCount: 0,
            stateSource: 'hook',
            stateConfidence: 1,
            stateObservedAt: new Date().toISOString(),
          },
          terminalFence:
            scenario === 'idle'
              ? { turnEpoch: 5, providerCursor: cursor, verdict: 'done', transitionId: 'stop-5' }
              : null,
          providerAt: at,
          acceptedAt: at,
          lastLiveReceiptAt: at,
          lastTransitionId: scenario === 'idle' ? 'stop-5' : 'working-5',
        }
        const summary = record({
          type: 'user',
          timestamp: '2026-10-30T15:25:42.345Z',
          isCompactSummary: true,
          message: {
            role: 'user',
            content: 'Summary of earlier work. '.repeat(Math.ceil(summaryBytes / 25)),
          },
        })
        const beforeSummary =
          scenario === 'lost_stop'
            ? finished
            : scenario === 'interrupt'
              ? prompt('[Request interrupted by user]')
              : scenario === 'tool_use' || scenario === 'question'
                ? record({
                    type: 'assistant',
                    timestamp: at,
                    message: {
                      role: 'assistant',
                      content: [
                        {
                          type: 'tool_use',
                          id: 'tool-1',
                          name: scenario === 'question' ? 'AskUserQuestion' : 'Bash',
                          input:
                            scenario === 'question'
                              ? {
                                  questions: [
                                    { question: 'Which option?', options: [{ label: 'A' }] },
                                  ],
                                }
                              : { command: 'true' },
                        },
                      ],
                    },
                  })
                : scenario === 'tool_result'
                  ? record({
                      type: 'user',
                      timestamp: at,
                      message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
                      },
                    })
                  : scenario === 'error'
                    ? record({
                        type: 'assistant',
                        timestamp: at,
                        message: {
                          role: 'assistant',
                          content: [{ type: 'text', text: 'API Error: 503 service unavailable' }],
                        },
                      })
                    : ''
        await appendFile(
          path,
          beforeSummary + summary + (scenario === 'next_prompt' ? prompt('do the next task') : ''),
        )

        const provider = agentStateProviderFor('claude-code')
        if (!provider) throw new Error('Claude provider missing')
        observers.initSessionObservers(
          {
            type: 'reattach',
            sessionId,
            durableLabel: 'podium-compaction-session',
            agentKind: 'claude-code',
            cwd: dir,
            lastKnownGeometry: { cols: 80, rows: 24 },
            resume: { kind: 'claude-session', value: 'claude-1' },
            pathHint: path,
            observationGeneration: 8,
            observationBindingVersion: 2,
            observationCheckpoint: checkpoint,
          },
          { onFrame: () => () => {} } as never,
          provider,
          { seedOnFrame: false },
        )
        const hook = { session_id: 'claude-1', transcript_path: path, cwd: dir }
        observers.onHookPayload(sessionId, { ...hook, hook_event_name: 'SessionStart' })
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        const bootstrap = sent[0]
        if (!bootstrap) throw new Error('Missing bootstrap observation')
        const working = [
          'working',
          'compacting_working',
          'tool_use',
          'tool_result',
          'next_prompt',
        ].includes(scenario)
        const expectedPhase = working
          ? 'working'
          : waiting || scenario === 'question'
            ? 'needs_user'
            : scenario === 'error'
              ? 'errored'
              : 'idle'
        expect(bootstrap).toMatchObject({
          provenance: 'bootstrap',
          turnEpoch: scenario === 'next_prompt' ? 6 : 5,
          nextPhase: expectedPhase,
        })
        expect(bootstrap.state.workingMsTotal).toBeGreaterThanOrEqual(920_171)
        if (!compacting) expect(bootstrap.state.workingMsTotal).toBe(920_171)
        if (expectedPhase === 'needs_user') expect(bootstrap.state.need?.kind).toBe('question')
        if (expectedPhase === 'idle') {
          expect(bootstrap.state.idle?.kind).toBe(scenario === 'interrupt' ? 'interrupted' : 'done')
          expect(bootstrap.state.since).toBe(at)
        }
        const lease = {
          provider: 'claude-code' as const,
          providerSessionId: 'claude-1',
          bindingVersion: 2,
          observationGeneration: 8,
        }
        const result = acceptAgentObservation(checkpoint, lease, bootstrap, at)
        if (result.kind === 'rejected') throw new Error(result.rejectionReason)
        if (expectedPhase !== 'errored') {
          expect(result.checkpoint.terminalFence?.turnEpoch).toBe(
            expectedPhase === 'idle' ? 5 : undefined,
          )
        }
        observers.onObservationAck({
          type: 'agentObservationAck',
          sessionId,
          observerGeneration: 8,
          transitionId: bootstrap.transitionId,
          result: result.kind,
          acceptedCursor: result.checkpoint.providerCursor,
          checkpoint: result.checkpoint,
        })
        if (working) {
          await appendFile(path, finished)
          observers.onHookPayload(sessionId, {
            ...hook,
            hook_event_name: 'Stop',
            ...(scenario === 'working' ? { prompt_id: 'prompt-5' } : {}),
          })
          await vi.waitFor(() => expect(sent).toHaveLength(2))
          const terminal = sent[1]
          if (!terminal) throw new Error('Missing terminal observation')
          expect(terminal).toMatchObject({
            transitionKind: 'turn_terminal',
            priorPhase: 'working',
            nextPhase: 'idle',
          })
          expect(acceptAgentObservation(result.checkpoint, lease, terminal, at).kind).toBe(
            'live_transition_accepted',
          )
        }
      } finally {
        observers.clearSession(sessionId)
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})
