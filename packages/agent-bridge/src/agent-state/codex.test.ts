import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyCodexVerdict,
  codexStateProvider,
  findCodexRolloutPath,
  findLiveCodexRollout,
  translateCodexEvent,
} from './codex.js'

const env = (ptype: string, extra: Record<string, unknown> = {}) => ({
  type: 'event_msg',
  payload: { type: ptype, ...extra },
})

describe('translateCodexEvent', () => {
  it('maps task_started / user_message to prompt_submitted', async () => {
    expect(await translateCodexEvent(env('task_started'))).toEqual([{ kind: 'prompt_submitted' }])
    expect(await translateCodexEvent(env('user_message', { message: 'hi' }))).toEqual([
      { kind: 'prompt_submitted' },
    ])
  })

  it('maps agent_message / token_count to activity', async () => {
    expect(await translateCodexEvent(env('agent_message'))).toEqual([{ kind: 'activity' }])
    expect(await translateCodexEvent(env('token_count'))).toEqual([{ kind: 'activity' }])
  })

  it('maps task_complete to turn_completed with a classified verdict', async () => {
    expect(
      await translateCodexEvent(env('task_complete', { last_agent_message: 'All done.' })),
    ).toEqual([{ kind: 'turn_completed', verdict: { kind: 'done', summary: 'All done.' } }])
    expect(
      await translateCodexEvent(env('task_complete', { last_agent_message: 'Which file?' })),
    ).toEqual([{ kind: 'turn_completed', verdict: { kind: 'question', summary: 'Which file?' } }])
  })

  it('maps turn_aborted to an interrupted turn_completed verdict', async () => {
    expect(await translateCodexEvent(env('turn_aborted'))).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'interrupted', summary: 'turn aborted' } },
    ])
  })

  it('ignores non-event_msg and unknown events', async () => {
    expect(
      await translateCodexEvent({ type: 'response_item', payload: { type: 'message' } }),
    ).toEqual([])
    expect(await translateCodexEvent(env('mystery_event'))).toEqual([])
  })
})

describe('classifyCodexVerdict', () => {
  it('treats a trailing question mark as a question, else done', () => {
    expect(classifyCodexVerdict('Should I proceed?').kind).toBe('question')
    expect(classifyCodexVerdict('Done.').kind).toBe('done')
    expect(classifyCodexVerdict(undefined).kind).toBe('done')
  })
})

describe('codexStateProvider', () => {
  it('injects nothing (observer-based, no hooks)', () => {
    expect(
      codexStateProvider.instrumentation({ endpointUrl: 'http://x', settingsPath: '/tmp/s' }),
    ).toEqual({ args: [] })
  })
})

describe('findLiveCodexRollout', () => {
  it('finds the newest rollout whose session_meta.cwd matches', async () => {
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'rollout-2026-06-16T16-11-26-uuid1.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'uuid1', cwd: '/repo/x' } })}\n`,
    )

    const found = await findLiveCodexRollout(sessions, '/repo/x', 0)
    expect(found?.path).toBe(file)
    expect(found?.id).toBe('uuid1')
  })

  it('returns undefined when no rollout matches the cwd', async () => {
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'rollout-other.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'u2', cwd: '/repo/other' } })}\n`,
    )

    expect(await findLiveCodexRollout(sessions, '/repo/x', 0)).toBeUndefined()
  })

  it('applies the freshness floor for a fresh spawn but ignores it on reattach (floor 0)', async () => {
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'rollout-idle.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'idle', cwd: '/repo/x' } })}\n`,
    )
    // A fresh spawn far in the future won't latch onto the older (idle) rollout…
    expect(await findLiveCodexRollout(sessions, '/repo/x', Date.now() + 60_000)).toBeUndefined()
    // …but reattach (floor 0) finds the live session's existing rollout regardless of age.
    expect((await findLiveCodexRollout(sessions, '/repo/x', 0))?.id).toBe('idle')
  })
})

describe('findCodexRolloutPath', () => {
  it('falls back to a filename match on the resume value when the state DB is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-home-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'rollout-2026-06-16T16-11-26-thread-xyz.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-xyz' } })}\n`,
    )

    expect(await findCodexRolloutPath({ resumeValue: 'thread-xyz', homeDir: home })).toBe(file)
    expect(await findCodexRolloutPath({ resumeValue: 'no-such-id', homeDir: home })).toBeUndefined()
  })
})
