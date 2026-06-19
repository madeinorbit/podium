import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  classifyCodexVerdict,
  codexStateProvider,
  findCodexRolloutPath,
  findLiveCodexRollout,
  observeCodexState,
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

describe('observeCodexState titles', () => {
  const jsonl = (lines: unknown[]): string => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`

  // Build `<home>/.codex/sessions/.../rollout-*.jsonl`; return its home + file path.
  async function writeRollout(
    lines: unknown[],
    id = 'uuidT',
  ): Promise<{ home: string; file: string }> {
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-title-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `rollout-2026-06-16T16-11-26-${id}.jsonl`)
    await writeFile(file, jsonl(lines))
    return { home, file }
  }

  const titleFrom = (home: string, cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        obs.stop()
        reject(new Error('onTitle was not called'))
      }, 3000)
      const obs = observeCodexState({
        cwd,
        homeDir: home,
        startedAtMs: 0,
        pollMs: 10,
        onTitle: (title) => {
          clearTimeout(timer)
          obs.stop()
          resolve(title)
        },
        onEvents: () => {},
      })
    })

  it('emits the first typed prompt as the title for a fresh session', async () => {
    const { home } = await writeRollout([
      { type: 'session_meta', payload: { id: 'uuidT', cwd: '/repo/title' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'add a dark mode toggle' } },
    ])
    expect(await titleFrom(home, '/repo/title')).toBe('add a dark mode toggle')
  })

  it('titles a session whose prompt arrives after the observer attaches (real spawn timing)', async () => {
    // Spawn order: Podium attaches the observer when only session_meta exists, then
    // the user types — the first prompt must still become the title as it lands.
    const { home, file } = await writeRollout([
      { type: 'session_meta', payload: { id: 'uuidT', cwd: '/repo/deferred' } },
    ])
    const title = titleFrom(home, '/repo/deferred')
    await writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { id: 'uuidT', cwd: '/repo/deferred' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'wire up CSV export' } },
      ]),
    )
    expect(await title).toBe('wire up CSV export')
  })

  it('does not title from an injected preamble before a real prompt arrives', async () => {
    // The AGENTS.md/permissions preamble lands as a `<…>` user_message first; it must
    // not win, and the next genuine prompt should.
    const { home, file } = await writeRollout([
      { type: 'session_meta', payload: { id: 'uuidT', cwd: '/repo/preamble' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<user_instructions>be good</user_instructions>',
        },
      },
    ])
    const title = titleFrom(home, '/repo/preamble')
    await writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { id: 'uuidT', cwd: '/repo/preamble' } },
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<user_instructions>be good</user_instructions>',
          },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'add pagination' } },
      ]),
    )
    expect(await title).toBe('add pagination')
  })
})

describe('observeCodexState native title (live /rename)', () => {
  const jsonl = (lines: unknown[]): string => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`

  // Write/overwrite the codex state DB's single `threads` row for `id`, setting its
  // `title` column — what a `/rename` inside Codex updates. Minimal schema: only the
  // columns the observer reads (id/rollout_path/title) need to be present.
  function setNativeTitle(home: string, id: string, rolloutRel: string, title: string): void {
    const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)',
    )
    db.prepare(
      'INSERT INTO threads (id, rollout_path, title) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET title = excluded.title',
    ).run(id, rolloutRel, title)
    db.close()
  }

  it('re-emits the native title when it changes mid-session (a /rename)', async () => {
    const id = 'uuidR'
    const cwd = '/repo/rename'
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-rename-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `rollout-2026-06-16T16-11-26-${id}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { id, cwd } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'initial prompt' } },
      ]),
    )

    const titles: string[] = []
    const obs = observeCodexState({
      cwd,
      homeDir: home,
      startedAtMs: 0,
      pollMs: 10,
      onTitle: (title) => titles.push(title),
      onEvents: () => {},
    })
    try {
      // First the prompt-derived title lands (no native title yet).
      await waitFor(() => titles.includes('initial prompt'))
      // User runs /rename → Codex writes the new title to the state DB.
      setNativeTitle(home, id, 'sessions/2026/06/16/dummy.jsonl', 'Renamed By User')
      await waitFor(() => titles.includes('Renamed By User'))
      // A re-poll with the same DB value must not re-emit it.
      await new Promise((r) => setTimeout(r, 60))
      expect(titles.filter((t) => t === 'Renamed By User')).toHaveLength(1)
      // The first-prompt fallback fired exactly once and the rename followed it.
      expect(titles).toEqual(['initial prompt', 'Renamed By User'])
    } finally {
      obs.stop()
    }
  })

  it('emits a native title that is set before any prompt (resumed-session path)', async () => {
    const id = 'uuidN'
    const cwd = '/repo/native'
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-native-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `rollout-2026-06-16T16-11-26-${id}.jsonl`)
    // No user_message in our tail window (resumed session) — only the native title applies.
    await writeFile(file, jsonl([{ type: 'session_meta', payload: { id, cwd } }]))
    setNativeTitle(home, id, 'sessions/2026/06/16/dummy.jsonl', 'Native Title')

    const titles: string[] = []
    const obs = observeCodexState({
      cwd,
      homeDir: home,
      startedAtMs: 0,
      pollMs: 10,
      onTitle: (title) => titles.push(title),
      onEvents: () => {},
    })
    try {
      await waitFor(() => titles.includes('Native Title'))
      await new Promise((r) => setTimeout(r, 60))
      expect(titles).toEqual(['Native Title'])
    } finally {
      obs.stop()
    }
  })
})

// Poll a predicate until true or a deadline, so a test reads the observer's emits
// without coupling to its exact poll cadence.
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate not satisfied in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

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
