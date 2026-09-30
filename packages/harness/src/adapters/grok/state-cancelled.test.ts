/** Cancellation evidence from Grok 1.0.44's TUI, run 2026-09-29 (POD-4865). */
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { AgentObservation, SessionObservationCheckpointV1 } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptAgentObservation, type ObservationLease } from '../../observer.js'
import { GrokCausalObserver } from './state-causal.js'
import { grokSessionPaths, observeGrokState, translateGrokUpdatePayload } from './state-provider.js'

const RUN = new URL(
  '../../../../../docs/measurements/pod-4834-receipt-proof/grok-tui-1.0.44/',
  import.meta.url,
)

function evidence<T>(path: string): T[] {
  return readFileSync(new URL(path, RUN), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

type Hook = { ev: string; payload: Record<string, unknown> }
type WatchedFile = {
  at: number
  file: string
  rec?: Record<string, unknown> & {
    type?: string
    outcome?: string
    cancellation_context?: { trigger?: string }
    params?: {
      update: {
        sessionUpdate: string
        event_name?: string
        prompt_id?: string
        stop_reason?: string
      }
    }
  }
}
type ObservedRecord = WatchedFile & { rec: NonNullable<WatchedFile['rec']> }

const hooks = evidence<Hook>('raw/hooks.jsonl')
const cancelledHooks = hooks.filter((hook) => hook.ev === 'StopCancelled')
const cancelled = cancelledHooks[0]!.payload
const sessionId = cancelled.sessionId as string
const promptId = cancelled.promptId as string
const submitted = hooks.find(
  (hook) => hook.ev === 'UserPromptSubmit' && hook.payload.promptId === promptId,
)!.payload
const observed = evidence<WatchedFile>('raw/session-files-observed.jsonl').filter(
  (row): row is ObservedRecord => row.rec !== undefined,
)
const completions = observed.filter(
  (row) =>
    row.file.endsWith('/updates.jsonl') &&
    row.rec.params?.update.sessionUpdate === 'turn_completed',
)
const cancelRecord = completions.find((row) => row.rec.params?.update.prompt_id === promptId)!
const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Grok StopCancelled from the recorded terminal run', () => {
  it('maps both measured Ctrl+C hooks to interrupted without reading an earlier answer', async () => {
    expect(cancelledHooks).toHaveLength(2)
    const onVerdictRead = vi.fn()
    for (const hook of cancelledHooks) {
      expect(hook.payload).toMatchObject({ reason: 'user_interrupt', cancelTrigger: 'ctrl_c' })
      await expect(translateGrokUpdatePayload(hook.payload, { onVerdictRead })).resolves.toEqual([
        { kind: 'turn_completed', verdict: { kind: 'interrupted' } },
      ])
    }
    expect(onVerdictRead).not.toHaveBeenCalled()
  })

  it.each([
    'StopCancelled',
    'stop_cancelled',
    'stop-cancelled',
  ])('normalizes the %s event spelling', async (hookEventName) => {
    await expect(translateGrokUpdatePayload({ ...cancelled, hookEventName })).resolves.toEqual([
      { kind: 'turn_completed', verdict: { kind: 'interrupted' } },
    ])
  })

  it('maps the recorded hook_execution markers to the same cancelled turn end', async () => {
    const markers = observed.filter(
      (row) =>
        row.file.endsWith('/updates.jsonl') &&
        row.rec.params?.update.event_name === 'stop_cancelled',
    )
    expect(markers).toHaveLength(2)
    for (const marker of markers) {
      expect(await translateGrokUpdatePayload(marker.rec)).toMatchObject([
        { kind: 'turn_completed', verdict: { kind: 'interrupted' } },
      ])
    }
  })

  it('closes a terminal-cancelled turn through the observer without a Podium interrupt request', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-cancelled-'))
    tmpDirs.push(home)
    const cwd = '/repo/grok-cancelled'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: sessionId, cwd } }))
    await writeFile(paths.updatesPath, '')
    const observations: AgentObservation[] = []
    const podiumSessionId = asSessionId('podium-cancelled')
    const lease: ObservationLease = {
      provider: 'grok',
      providerSessionId: sessionId,
      bindingVersion: 1,
      observationGeneration: 1,
    }
    let checkpoint: SessionObservationCheckpointV1 | null = null
    const observer = observeGrokState({
      cwd,
      homeDir: home,
      resumeValue: sessionId,
      pollMs: 10,
      causal: {
        podiumSessionId,
        providerSessionId: sessionId,
        bindingVersion: 1,
        observerGeneration: 1,
        acceptedCheckpoint: null,
        onObservation: (observation) => observations.push(observation),
      },
    })
    const accept = (observation: AgentObservation): void => {
      const result = acceptAgentObservation(
        checkpoint,
        lease,
        observation,
        '2026-09-29T16:15:03.000Z',
      )
      if (result.kind === 'rejected') throw new Error(result.rejectionReason)
      checkpoint = result.checkpoint
      observer.onObservationAck?.({
        type: 'agentObservationAck',
        sessionId: podiumSessionId,
        observerGeneration: 1,
        bindingVersion: 1,
        transitionId: observation.transitionId,
        result: result.kind,
        acceptedCursor: result.checkpoint.providerCursor,
        checkpoint: result.checkpoint,
      })
    }
    try {
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      accept(observations[0]!)
      expect(observer.onHookPayload?.(submitted)).toBe(true)
      await vi.waitFor(() => expect(observations).toHaveLength(2))
      accept(observations[1]!)
      expect(observer.onHookPayload?.(cancelled)).toBe(true)
      await vi.waitFor(() => expect(observations).toHaveLength(3))
      expect(observations[2]).toMatchObject({
        transitionKind: 'turn_terminal',
        sourceEventKind: 'hook:stop_cancelled',
        providerPromptId: promptId,
        nextPhase: 'idle',
        state: { idle: { kind: 'interrupted' } },
      })
      accept(observations[2]!)

      // The file follows the hook promptly, rather than being a second turn end.
      const nextPrompt = observed.find(
        (row) =>
          row.at > cancelRecord.at && row.rec.params?.update.event_name === 'user_prompt_submit',
      )!
      await appendFile(
        paths.updatesPath,
        [cancelRecord.rec, nextPrompt.rec].map((record) => JSON.stringify(record) + '\n').join(''),
      )
      await vi.waitFor(() => expect(observations).toHaveLength(4))
      expect(observations[3]).toMatchObject({ transitionKind: 'turn_opened', nextPhase: 'working' })
      accept(observations[3]!)
      expect(observer.onHookPayload?.(cancelled)).toBe(true)
      expect(observations).toHaveLength(4)
    } finally {
      observer.stop()
    }
  })

  it('ignores an older prompt cancellation after a newer turn opens', () => {
    const observations: AgentObservation[] = []
    const causal = new GrokCausalObserver({
      podiumSessionId: asSessionId('podium-cancelled-late'),
      providerSessionId: sessionId,
      bindingVersion: 1,
      observerGeneration: 1,
      acceptedCheckpoint: null,
      onObservation: (observation) => observations.push(observation),
    })
    const segment = {
      segmentId: 'cancelled-late',
      pathHint: '/updates.jsonl',
      device: '1',
      inode: '2',
    }
    expect(causal.observeHook({ ...submitted, promptId: 'newer-prompt' }, segment)).toBe(true)
    const opened = observations[0]!
    causal.acknowledge({
      type: 'agentObservationAck',
      sessionId: asSessionId('podium-cancelled-late'),
      observerGeneration: 1,
      bindingVersion: 1,
      transitionId: opened.transitionId,
      result: 'live_transition_accepted',
      acceptedCursor: opened.providerCursor,
    })
    expect(causal.observeHook(cancelled, segment)).toBe(true)
    causal.enqueue({
      record: cancelRecord.rec,
      cursor: causal.cursorFor(segment, 100),
      events: [{ kind: 'turn_completed', verdict: { kind: 'interrupted' } }],
      sourceEventKind: 'update:turn_completed',
      providerAt: null,
    })
    expect(observations).toHaveLength(1)
    expect(observations[0]?.nextPhase).toBe('working')
  })

  it.each([
    { promptId: null },
    { sessionId: 'another-session' },
    { subagentType: 'explore' },
  ])('leaves the main turn open for an unbound cancellation: %j', (fields) => {
    const observations: AgentObservation[] = []
    const causal = new GrokCausalObserver({
      podiumSessionId: asSessionId('podium-cancelled-unbound'),
      providerSessionId: sessionId,
      bindingVersion: 1,
      observerGeneration: 1,
      acceptedCheckpoint: null,
      onObservation: (observation) => observations.push(observation),
    })
    const segment = {
      segmentId: 'cancelled-unbound',
      pathHint: '/updates.jsonl',
      device: '1',
      inode: '2',
    }
    expect(causal.observeHook(submitted, segment)).toBe(true)
    const opened = observations[0]!
    causal.acknowledge({
      type: 'agentObservationAck',
      sessionId: asSessionId('podium-cancelled-unbound'),
      observerGeneration: 1,
      bindingVersion: 1,
      transitionId: opened.transitionId,
      result: 'live_transition_accepted',
      acceptedCursor: opened.providerCursor,
    })
    expect(causal.observeHook({ ...cancelled, ...fields }, segment)).toBe(true)
    expect(observations).toHaveLength(1)
  })

  it('pins the observed completion timing to within 350 ms in all 37 turns', async () => {
    const ends = observed.filter(
      (row) => row.file.endsWith('/events.jsonl') && row.rec.type === 'turn_ended',
    )
    expect(ends).toHaveLength(37)
    expect(completions).toHaveLength(37)
    // Pair in each file's order. Resume records were sometimes seen first in
    // updates.jsonl; pairing by the next wall-clock record invents 17 s delays.
    const deltas = ends.map((end, index) => {
      const completion = completions[index]!
      expect(completion.rec.params?.update.stop_reason).toBe(
        end.rec.outcome === 'completed' ? 'end_turn' : end.rec.outcome,
      )
      return completion.at - end.at
    })
    expect(Math.max(...deltas.map(Math.abs))).toBeLessThanOrEqual(350)

    const sendNowIndex = ends.findIndex(
      (end) => end.rec.cancellation_context?.trigger === 'send_now',
    )
    expect(sendNowIndex).toBeGreaterThanOrEqual(0)
    expect(deltas[sendNowIndex]).toBe(335)
    const sendNow = completions[sendNowIndex]!
    expect(
      hooks.some(
        (hook) =>
          hook.ev === 'StopCancelled' &&
          hook.payload.promptId === sendNow.rec.params?.update.prompt_id,
      ),
    ).toBe(false)
    expect(await translateGrokUpdatePayload(sendNow.rec)).toMatchObject([
      { kind: 'turn_completed', verdict: { kind: 'interrupted' } },
    ])
  })
})
