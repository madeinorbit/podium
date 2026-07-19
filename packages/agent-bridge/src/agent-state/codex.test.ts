import { appendFile, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import type { AgentObservation } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptAgentObservation, type ObservationLease } from './causal.js'
import {
  CodexCausalCursorObserver,
  classifyCodexVerdict,
  codexApprovalsReviewerFromTranscript,
  codexBootstrapObservation,
  codexPodiumSessionMarker,
  codexStateProvider,
  findCodexRolloutPath,
  findLiveCodexRollout,
  findProcessBoundCodexRollout,
  foldCodexRolloutBootstrap,
  observeCodexState,
  translateCodexEvent,
} from './codex.js'

const env = (ptype: string, extra: Record<string, unknown> = {}) => ({
  type: 'event_msg',
  payload: { type: ptype, ...extra },
})

const permissionRecord = (reviewer: 'user' | 'auto_review' | 'guardian_subagent') => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text:
          '<permissions instructions>\n' +
          `\`approvals_reviewer\` is \`${reviewer}\`: escalation routing.\n` +
          '</permissions instructions>',
      },
    ],
  },
})

const turnContextRecord = (reviewer: 'user' | 'auto_review' | 'guardian_subagent') => ({
  type: 'turn_context',
  payload: { approvals_reviewer: reviewer },
})

async function writePermissionTranscript(
  reviewer: 'user' | 'auto_review' | 'guardian_subagent',
  extra: unknown[] = [],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-codex-permission-'))
  const path = join(dir, 'rollout.jsonl')
  await writeFile(
    path,
    `${[permissionRecord(reviewer), ...extra].map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
  return path
}

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

  it('maps legacy guardian_assessment events to activity', async () => {
    expect(
      await translateCodexEvent(env('guardian_assessment', { status: 'in_progress' })),
    ).toEqual([{ kind: 'activity' }])
    expect(await translateCodexEvent(env('guardian_assessment', { status: 'denied' }))).toEqual([
      { kind: 'activity' },
    ])
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

  it('maps request_user_input calls to needs_user/question and tool results back to activity', async () => {
    const timestamp = '2026-07-13T08:47:06.776Z'
    expect(
      await translateCodexEvent({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'call-question',
          arguments: JSON.stringify({
            questions: [{ question: 'How ambitious should the first version be?' }],
          }),
        },
      }),
    ).toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: 'How ambitious should the first version be?',
        at: timestamp,
      },
    ])
    expect(
      await translateCodexEvent({
        timestamp: '2026-07-13T08:48:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-question',
          output: '{"v1_depth":"hybrid"}',
        },
      }),
    ).toEqual([{ kind: 'activity', at: '2026-07-13T08:48:00.000Z' }])
  })

  it('ignores ordinary rollout tool starts so they cannot race and clear a permission hook', async () => {
    expect(
      await translateCodexEvent({
        type: 'response_item',
        payload: { type: 'function_call', name: 'wait', arguments: '{"cell_id":"3"}' },
      }),
    ).toEqual([])
  })

  it('ignores non-event_msg and unknown events', async () => {
    expect(
      await translateCodexEvent({ type: 'response_item', payload: { type: 'message' } }),
    ).toEqual([])
    expect(await translateCodexEvent(env('mystery_event'))).toEqual([])
  })

  it('stamps the record timestamp as event-time (at) so reattach replays carry the real time', async () => {
    const ts = '2026-06-12T13:49:53.366Z'
    const events = await translateCodexEvent({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'task_complete', last_agent_message: 'done' },
    })
    expect(events[0]?.at).toBe(ts)
  })
})

describe('translateCodexEvent — native hook payloads (hook_event_name)', () => {
  const hook = (event: string, extra: Record<string, unknown> = {}) => ({
    session_id: '019f38c0-efde-7fb0-838d-55cf6fc7691a',
    transcript_path: '/home/u/.codex/sessions/2026/07/06/rollout-x.jsonl',
    cwd: '/repo/x',
    hook_event_name: event,
    ...extra,
  })

  it('maps SessionStart to session_started', async () => {
    expect(await translateCodexEvent(hook('SessionStart', { source: 'startup' }))).toEqual([
      { kind: 'session_started' },
    ])
  })

  it('maps UserPromptSubmit to prompt_submitted', async () => {
    expect(await translateCodexEvent(hook('UserPromptSubmit', { prompt: 'do it' }))).toEqual([
      { kind: 'prompt_submitted' },
    ])
  })

  it('maps Pre/PostToolUse to activity', async () => {
    expect(await translateCodexEvent(hook('PreToolUse', { tool_name: 'Bash' }))).toEqual([
      { kind: 'activity' },
    ])
    expect(await translateCodexEvent(hook('PostToolUse', { tool_name: 'Bash' }))).toEqual([
      { kind: 'activity' },
    ])
  })

  it('maps request_user_input PreToolUse to needs_user/question', async () => {
    expect(
      await translateCodexEvent(
        hook('PreToolUse', {
          tool_name: 'request_user_input',
          tool_input: {
            questions: [{ question: 'Who should advance each workflow phase?' }],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: 'Who should advance each workflow phase?',
      },
    ])
  })

  it('maps a user-reviewed PermissionRequest to needs_user/permission with the tool name', async () => {
    // The rollout can NEVER carry this signal (codex pauses without writing);
    // the hook is the only source for the amber "waiting on approval" state.
    const transcript_path = await writePermissionTranscript('user')
    expect(
      await translateCodexEvent(hook('PermissionRequest', { tool_name: 'Bash', transcript_path })),
    ).toEqual([{ kind: 'needs_user', need: 'permission', summary: 'Bash' }])
  })

  it.each([
    'auto_review',
    'guardian_subagent',
  ] as const)('keeps an automatically reviewed PermissionRequest working (%s)', async (reviewer) => {
    const transcript_path = await writePermissionTranscript(reviewer)
    expect(
      await translateCodexEvent(hook('PermissionRequest', { tool_name: 'Bash', transcript_path })),
    ).toEqual([{ kind: 'activity' }])
  })

  it('defaults an unclassified PermissionRequest to needs_user', async () => {
    expect(await translateCodexEvent(hook('PermissionRequest', { tool_name: 'Bash' }))).toEqual([
      { kind: 'needs_user', need: 'permission', summary: 'Bash' },
    ])
    expect(
      await translateCodexEvent(
        hook('PermissionRequest', {
          tool_name: 'Bash',
          transcript_path: '/no/such/codex-rollout.jsonl',
        }),
      ),
    ).toEqual([{ kind: 'needs_user', need: 'permission', summary: 'Bash' }])
  })

  it('uses the latest per-turn reviewer from the bounded transcript tail', async () => {
    const largeRecord = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'x'.repeat(1024 * 1024) }],
      },
    }
    const transcript_path = await writePermissionTranscript('user', [
      largeRecord,
      turnContextRecord('auto_review'),
    ])
    expect(
      await translateCodexEvent(hook('PermissionRequest', { tool_name: 'Bash', transcript_path })),
    ).toEqual([{ kind: 'activity' }])

    const manual_path = await writePermissionTranscript('auto_review', [
      largeRecord,
      turnContextRecord('user'),
    ])
    expect(
      await translateCodexEvent(
        hook('PermissionRequest', { tool_name: 'Bash', transcript_path: manual_path }),
      ),
    ).toEqual([{ kind: 'needs_user', need: 'permission', summary: 'Bash' }])
  })

  it('maps Stop to a classified turn_completed from last_assistant_message', async () => {
    expect(
      await translateCodexEvent(hook('Stop', { last_assistant_message: 'Should I merge?' })),
    ).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'question', summary: 'Should I merge?' } },
    ])
  })

  it('ignores unknown hook events', async () => {
    expect(await translateCodexEvent(hook('PreCompact'))).toEqual([])
  })
})

describe('classifyCodexVerdict', () => {
  it('treats a trailing question mark as a question, else done', () => {
    expect(classifyCodexVerdict('Should I proceed?').kind).toBe('question')
    expect(classifyCodexVerdict('Done.').kind).toBe('done')
    expect(classifyCodexVerdict(undefined).kind).toBe('done')
  })
})

describe('codexApprovalsReviewerFromTranscript', () => {
  it('prefers the latest structured turn context over the developer fallback', () => {
    const misleading = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '`approvals_reviewer` is `auto_review`' }],
      },
    }
    const jsonl = [permissionRecord('user'), misleading, turnContextRecord('auto_review')]
      .map((r) => JSON.stringify(r))
      .join('\n')
    expect(codexApprovalsReviewerFromTranscript(jsonl)).toBe('auto_review')
  })

  it('ignores malformed and unrelated records', () => {
    expect(codexApprovalsReviewerFromTranscript('{torn\n{"type":"event_msg"}')).toBeUndefined()
  })
})

describe('codexStateProvider', () => {
  it('injects the per-session callback for the global hook install', () => {
    expect(
      codexStateProvider.instrumentation({
        endpointUrl: 'http://x',
        settingsPath: '/tmp/s',
        socketPath: '/run/podium/hooks.sock',
        receiptDir: '/state/podium/codex-receipts',
      }),
    ).toEqual({
      args: [],
      env: {
        PODIUM_CODEX_HOOK_URL: 'http://x',
        PODIUM_CODEX_HOOK_SOCKET: '/run/podium/hooks.sock',
        PODIUM_CODEX_HOOK_RECEIPT_DIR: '/state/podium/codex-receipts',
      },
    })
  })

  it('seedTheme adds the official per-invocation tui.theme=ansi override; off adds nothing [spec:SP-a04d]', () => {
    expect(
      codexStateProvider.instrumentation({
        endpointUrl: 'http://x',
        settingsPath: '/tmp/s',
        seedTheme: true,
      }),
    ).toEqual({
      args: ['-c', 'tui.theme=ansi'],
      env: { PODIUM_CODEX_HOOK_URL: 'http://x' },
    })
    expect(
      codexStateProvider.instrumentation({
        endpointUrl: 'http://x',
        settingsPath: '/tmp/s',
        seedTheme: false,
      }),
    ).toEqual({
      args: [],
      env: { PODIUM_CODEX_HOOK_URL: 'http://x' },
    })
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

  it('does not latch a fresh spawn onto a sibling whose rollout mtime is fresh but session is old', async () => {
    // The sidebar-collapse bug: several Codex panes share a repo cwd. An ACTIVE
    // sibling keeps appending to its rollout, so file mtime stays recent. A new
    // spawn used mtime for discovery → every pane inherited the sibling's
    // codex-thread id → dedupeSessionsByResume hid the rest in the sidebar.
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-sibling-'))
    const dir = join(sessions, '2026', '06', '25')
    await mkdir(dir, { recursive: true })
    const cwd = '/repo/podium'
    const spawnAt = Date.parse('2026-06-25T12:00:00.000Z')

    const sibling = join(dir, 'rollout-2026-06-25T10-00-00-sessA.jsonl')
    await writeFile(
      sibling,
      `${JSON.stringify({
        timestamp: '2026-06-25T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sessA', cwd, source: 'cli', timestamp: '2026-06-25T10:00:00.000Z' },
      })}\n`,
    )
    const fresh = join(dir, 'rollout-2026-06-25T12-00-01-sessB.jsonl')
    await writeFile(
      fresh,
      `${JSON.stringify({
        timestamp: '2026-06-25T12:00:01.000Z',
        type: 'session_meta',
        payload: { id: 'sessB', cwd, source: 'cli', timestamp: '2026-06-25T12:00:01.000Z' },
      })}\n`,
    )
    // Sibling is actively writing — mtime is NEWER than the fresh session's file.
    await utimes(sibling, new Date(spawnAt + 5000), new Date(spawnAt + 5000))
    await utimes(fresh, new Date(spawnAt + 1000), new Date(spawnAt + 1000))

    const found = await findLiveCodexRollout(sessions, cwd, spawnAt)
    expect(found?.id).toBe('sessB')
    expect(found?.path).toBe(fresh)
  })

  it('matches an unsettled pane by its exact launch marker, never a sibling by time', async () => {
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-identity-'))
    const dir = join(sessions, '2026', '07', '15')
    await mkdir(dir, { recursive: true })
    const cwd = '/repo/podium'
    const earlierPane = '11111111-1111-4111-8111-111111111111'
    const owningPane = '22222222-2222-4222-8222-222222222222'
    const rollout = join(dir, 'rollout-owner.jsonl')
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'native-owner',
            cwd,
            source: 'cli',
            timestamp: '2026-07-15T09:10:31.000Z',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: codexPodiumSessionMarker(owningPane) }],
          },
        }),
      ].join('\n'),
    )

    expect(
      await findLiveCodexRollout(
        sessions,
        cwd,
        Date.parse('2026-07-15T08:11:19.000Z'),
        earlierPane,
      ),
    ).toBeUndefined()
    const exact = await findLiveCodexRollout(
      sessions,
      cwd,
      Date.parse('2026-07-15T09:10:28.000Z'),
      owningPane,
    )
    expect(exact).toMatchObject({
      id: 'native-owner',
      path: rollout,
      confidence: 'exact',
    })
    expect(
      (await findLiveCodexRollout(sessions, cwd, Date.parse('2026-07-15T08:11:19.000Z')))
        ?.confidence,
    ).toBe('heuristic')
  })

  it('ignores the newer guardian subagent rollout and returns the interactive cli session', async () => {
    // Codex ≥0.142 writes a SECOND rollout per interactive session for its internal
    // "guardian" risk-judging subagent: same cwd, NEWER mtime, its own thread id, but
    // `source: { subagent: … }`. Sorting by mtime would latch onto the guardian and
    // cross-wire the chat view to its "judging one planned action" transcript.
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '06', '25')
    await mkdir(dir, { recursive: true })

    const cli = join(dir, 'rollout-2026-06-25T11-07-49-cliid.jsonl')
    await writeFile(
      cli,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'cliid', cwd: '/repo/x', source: 'cli' } })}\n`,
    )
    const guardian = join(dir, 'rollout-2026-06-25T11-07-50-guardid.jsonl')
    await writeFile(
      guardian,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'guardid', cwd: '/repo/x', source: { subagent: { other: 'guardian' } } } })}\n`,
    )
    // Make the guardian strictly newer so an mtime sort would pick it.
    await utimes(cli, new Date(1000), new Date(1000))
    await utimes(guardian, new Date(2000), new Date(2000))

    const found = await findLiveCodexRollout(sessions, '/repo/x', 0)
    expect(found?.path).toBe(cli)
    expect(found?.id).toBe('cliid')
  })

  it('matches a rollout whose session_meta line exceeds the 4KB head probe (escalation path)', async () => {
    // The walk probes only the first 4 KB per file (POD-601: the old 256 KB read
    // per file was the daemon's dominant heap churn). A first line longer than the
    // probe must escalate to the full prefix read and still match — including the
    // launch marker further down the prefix.
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '07', '15')
    await mkdir(dir, { recursive: true })
    const pane = '33333333-3333-4333-8333-333333333333'
    const rollout = join(dir, 'rollout-2026-07-15T09-10-31-bigmeta.jsonl')
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'bigmeta',
            cwd: '/repo/x',
            source: 'cli',
            timestamp: '2026-07-15T09:10:31.000Z',
            pad: 'x'.repeat(8 * 1024),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: codexPodiumSessionMarker(pane) }],
          },
        }),
      ].join('\n'),
    )

    const found = await findLiveCodexRollout(
      sessions,
      '/repo/x',
      Date.parse('2026-07-15T09:10:30.000Z'),
      pane,
    )
    expect(found).toMatchObject({ id: 'bigmeta', path: rollout, confidence: 'exact' })
  })

  it('still finds a rollout filed under the PREVIOUS day directory (timezone skew vs the prune)', async () => {
    // Day-directory pruning must keep enough slack that a rollout whose local-date
    // directory lags its UTC session_meta timestamp is still walked.
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2026', '06', '15') // previous day's directory
    await mkdir(dir, { recursive: true })
    const rollout = join(dir, 'rollout-2026-06-15T23-30-00-skew.jsonl')
    await writeFile(
      rollout,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'skew', cwd: '/repo/x', source: 'cli', timestamp: '2026-06-16T01:30:00.000Z' },
      })}\n`,
    )

    const found = await findLiveCodexRollout(sessions, '/repo/x', Date.parse('2026-06-16T01:00:00.000Z'))
    expect(found?.id).toBe('skew')
  })

  it('walks non-date directory layouts even with a fresh floor (pruning never skips off-layout dirs)', async () => {
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, 'misc', 'nested')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'rollout-offlayout.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'offlayout', cwd: '/repo/x', source: 'cli', timestamp: '2026-06-16T02:00:00.000Z' },
      })}\n`,
    )

    const found = await findLiveCodexRollout(sessions, '/repo/x', Date.parse('2026-06-16T01:00:00.000Z'))
    expect(found?.id).toBe('offlayout')
  })

  it('prunes date directories far older than the floor without listing them', async () => {
    // Pins the POD-601 walk optimization: with a fresh floor, an ancient
    // sessions/YYYY/MM/DD subtree is skipped outright. (Codex always files a
    // rollout under its creation date, so dir date and session_meta timestamp
    // can only diverge by a timezone offset — covered by the 48h slack above.)
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-obs-'))
    const dir = join(sessions, '2020', '01', '01')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'rollout-ancient-dir.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'ancient', cwd: '/repo/x', source: 'cli', timestamp: '2026-06-16T02:00:00.000Z' },
      })}\n`,
    )

    expect(
      await findLiveCodexRollout(sessions, '/repo/x', Date.parse('2026-06-16T01:00:00.000Z')),
    ).toBeUndefined()
  })
})

describe('findProcessBoundCodexRollout', () => {
  it('maps same-cwd siblings by inherited Podium id and the owning rollout FD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-codex-process-'))
    const sessions = join(root, 'home', '.codex', 'sessions')
    const day = join(sessions, '2026', '07', '16')
    const proc = join(root, 'proc')
    await mkdir(day, { recursive: true })
    const cwd = '/repo/shared'
    const paneA = '11111111-1111-4111-8111-111111111111'
    const paneB = '22222222-2222-4222-8222-222222222222'
    const rolloutA = join(day, 'rollout-a.jsonl')
    const rolloutB = join(day, 'rollout-b.jsonl')
    const guardian = join(day, 'rollout-guardian.jsonl')
    await writeFile(
      rolloutA,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'native-a',
          cwd,
          source: 'cli',
          timestamp: '2026-07-16T10:00:00.000Z',
        },
      })}\n`,
    )
    await writeFile(
      rolloutB,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'native-b',
          cwd,
          source: 'cli',
          timestamp: '2026-07-16T10:00:01.000Z',
        },
      })}\n`,
    )
    await writeFile(
      guardian,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'guardian', cwd, source: { subagent: { other: 'guardian' } } },
      })}\n`,
    )

    const process = async (pid: number, podiumId: string, paths: string[]): Promise<void> => {
      const dir = join(proc, String(pid))
      const fds = join(dir, 'fd')
      await mkdir(fds, { recursive: true })
      await writeFile(join(dir, 'cmdline'), 'codex\0')
      await writeFile(join(dir, 'environ'), `TERM=xterm\0PODIUM_SESSION_ID=${podiumId}\0`)
      await Promise.all(paths.map((path, i) => symlink(path, join(fds, String(i + 3)))))
    }
    await process(101, paneA, [rolloutA, guardian])
    await process(202, paneB, [rolloutB])

    await expect(findProcessBoundCodexRollout(sessions, paneA, proc)).resolves.toMatchObject({
      id: 'native-a',
      path: rolloutA,
      confidence: 'exact',
    })
    await expect(findProcessBoundCodexRollout(sessions, paneB, proc)).resolves.toMatchObject({
      id: 'native-b',
      path: rolloutB,
      confidence: 'exact',
    })
  })
})

describe('foldCodexRolloutBootstrap', () => {
  const tempRoots: string[] = []
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  const line = (record: unknown): string => `${JSON.stringify(record)}\n`
  const event = (type: string, timestamp: string, extra: Record<string, unknown> = {}): string =>
    line({ type: 'event_msg', timestamp, payload: { type, ...extra } })

  async function rollout(contents: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-fold-'))
    const dir = join(home, '.codex', 'sessions', '2026', '07', '19')
    tempRoots.push(home)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'rollout-bootstrap.jsonl')
    await writeFile(path, contents)
    return path
  }

  function acceptBootstrap(
    folded: Awaited<ReturnType<typeof foldCodexRolloutBootstrap>>,
    providerSessionId: string,
  ) {
    const now = '2026-07-19T12:00:00.000Z'
    const outcome = acceptAgentObservation(
      null,
      {
        provider: 'codex',
        providerSessionId,
        bindingVersion: 1,
        observationGeneration: 1,
      },
      codexBootstrapObservation(
        {
          podiumSessionId: 'podium-checkpoint',
          providerSessionId,
          observerGeneration: 1,
          bindingVersion: 1,
          now: () => now,
        },
        folded,
      ),
      now,
    )
    if (outcome.kind === 'rejected') throw new Error(outcome.rejectionReason)
    return outcome.checkpoint
  }

  it('folds frozen history larger than 128KiB into one exact terminal snapshot', async () => {
    const threadId = 'thread-bootstrap'
    const turnId = 'turn-bootstrap'
    const contents =
      line({
        type: 'session_meta',
        timestamp: '2026-07-19T08:00:00.000Z',
        payload: { id: threadId, cwd: '/repo/x', source: 'cli' },
      }) +
      event('task_started', '2026-07-19T08:00:01.000Z', { turn_id: turnId }) +
      line({
        type: 'turn_context',
        timestamp: '2026-07-19T08:00:01.100Z',
        payload: { turn_id: turnId, cwd: '/repo/x' },
      }) +
      event('user_message', '2026-07-19T08:00:01.200Z', {
        prompt_id: 'prompt-bootstrap',
        message: 'keep the cursor exact',
      }) +
      line({
        type: 'response_item',
        timestamp: '2026-07-19T08:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x'.repeat(256 * 1024) }],
        },
      }) +
      event('task_complete', '2026-07-19T08:00:03.000Z', {
        last_agent_message: 'Done once.',
      })
    const path = await rollout(contents)

    const folded = await foldCodexRolloutBootstrap(path)

    expect(Buffer.byteLength(contents)).toBeGreaterThan(128 * 1024)
    expect(folded.providerSessionId).toBe(threadId)
    expect(folded.providerTurnId).toBe(turnId)
    expect(folded.providerPromptId).toBe('prompt-bootstrap')
    expect(folded.turnEpoch).toBe(1)
    expect(folded.state).toMatchObject({
      phase: 'idle',
      idle: { kind: 'done', summary: 'Done once.' },
    })
    expect(folded.providerCursor).toMatchObject({
      pathHint: path,
      components: { file: Buffer.byteLength(contents) },
    })
    expect(folded.providerCursor.device).toMatch(/^\d+$/)
    expect(folded.providerCursor.inode).toMatch(/^\d+$/)
    expect(folded.providerCursor.segmentId).toBe(
      `codex-rollout:${folded.providerCursor.device}:${folded.providerCursor.inode}`,
    )
  })

  it('captures only complete records and leaves a torn prompt outside the cursor', async () => {
    const complete =
      line({
        type: 'session_meta',
        payload: { id: 'thread-torn', cwd: '/repo/x', source: 'cli' },
      }) +
      event('task_complete', '2026-07-19T08:10:00.000Z', {
        last_agent_message: 'Frozen.',
      })
    const torn = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-19T08:11:00.000Z',
      payload: { type: 'task_started', turn_id: 'not-complete-yet' },
    }).slice(0, -7)
    const path = await rollout(complete + torn)

    const folded = await foldCodexRolloutBootstrap(path)

    expect(folded.providerCursor.components.file).toBe(Buffer.byteLength(complete))
    expect(folded.state.phase).toBe('idle')
    expect(folded.turnEpoch).toBe(0)
  })

  it('restores an exact EOF checkpoint without rescanning frozen history', async () => {
    const contents =
      line({ type: 'session_meta', payload: { id: 'thread-resume', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:15:00.000Z', { turn_id: 'turn-resume' }) +
      event('task_complete', '2026-07-19T08:15:01.000Z')
    const path = await rollout(contents)
    const folded = await foldCodexRolloutBootstrap(path)
    const checkpoint = acceptBootstrap(folded, 'thread-resume')
    const rewritten = contents.replace('task_complete', 'token_count__')
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(contents))
    await writeFile(path, rewritten)
    const resumed = await foldCodexRolloutBootstrap(path, checkpoint)
    expect(resumed.state.phase).toBe('idle')
    expect(resumed.turnEpoch).toBe(checkpoint.turnEpoch)
    expect(resumed.providerCursor).toEqual(checkpoint.providerCursor)
  })

  it('folds only a checkpoint gap when a torn record completes after restart', async () => {
    const complete =
      line({ type: 'session_meta', payload: { id: 'thread-torn-restart', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:16:00.000Z', { turn_id: 'turn-frozen' }) +
      event('task_complete', '2026-07-19T08:16:01.000Z')
    const nextRecord = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-19T08:17:00.000Z',
      payload: { type: 'task_started', turn_id: 'turn-after-restart' },
    })
    const torn = nextRecord.slice(0, -5)
    const path = await rollout(complete + torn)
    const frozen = await foldCodexRolloutBootstrap(path)
    const checkpoint = acceptBootstrap(frozen, 'thread-torn-restart')
    await appendFile(path, `${nextRecord.slice(-5)}\n`)
    const resumed = await foldCodexRolloutBootstrap(path, checkpoint)
    expect(resumed.providerCursor.components.file).toBe(
      Buffer.byteLength(`${complete}${nextRecord}\n`),
    )
    expect(resumed.turnEpoch).toBe(2)
    expect(resumed.state.phase).toBe('working')
    expect(resumed.turnOpen).toBe(true)
    expect(resumed.providerTurnId).toBe('turn-after-restart')
  })

  it('starts a fresh bootstrap after truncation or inode rotation', async () => {
    const original =
      line({ type: 'session_meta', payload: { id: 'thread-before-change', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:18:00.000Z', { turn_id: 'turn-before-change' }) +
      line({
        type: 'response_item',
        payload: { type: 'message', content: 'x'.repeat(8192) },
      }) +
      event('task_complete', '2026-07-19T08:18:01.000Z')
    const path = await rollout(original)
    const frozen = await foldCodexRolloutBootstrap(path)
    const checkpoint = acceptBootstrap(frozen, 'thread-before-change')
    const truncatedContents =
      line({ type: 'session_meta', payload: { id: 'thread-truncated', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:19:00.000Z', { turn_id: 'turn-truncated' })
    expect(Buffer.byteLength(truncatedContents)).toBeLessThan(
      checkpoint.providerCursor?.components.file ?? 0,
    )
    await writeFile(path, truncatedContents)
    const truncated = await foldCodexRolloutBootstrap(path, checkpoint)
    expect(truncated.providerSessionId).toBe('thread-truncated')
    expect(truncated.state.phase).toBe('working')
    expect(truncated.providerCursor.components.file).toBe(Buffer.byteLength(truncatedContents))
    expect(truncated.providerCursor.segmentId).not.toBe(checkpoint.providerCursor?.segmentId)
    expect(truncated.providerCursor.predecessorSegmentId).toBe(checkpoint.providerCursor?.segmentId)
    await rename(path, `${path}.old`)
    const rotatedContents =
      line({ type: 'session_meta', payload: { id: 'thread-rotated', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:20:00.000Z', { turn_id: 'turn-rotated' }) +
      event('task_complete', '2026-07-19T08:20:01.000Z')
    await writeFile(path, rotatedContents)
    const rotated = await foldCodexRolloutBootstrap(path, checkpoint)
    expect(rotated.providerSessionId).toBe('thread-rotated')
    expect(rotated.state.phase).toBe('idle')
    expect(rotated.providerCursor.segmentId).not.toBe(checkpoint.providerCursor?.segmentId)
    expect(rotated.providerCursor.predecessorSegmentId).toBe(checkpoint.providerCursor?.segmentId)
  })

  it('discards an oversized content record without losing later state boundaries', async () => {
    const contents =
      line({ type: 'session_meta', payload: { id: 'thread-large', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:20:00.000Z', { turn_id: 'turn-large' }) +
      line({
        type: 'response_item',
        payload: { type: 'blob', data: 'x'.repeat(5 * 1024 * 1024) },
      }) +
      event('task_complete', '2026-07-19T08:20:01.000Z', {
        last_agent_message: 'Still bounded.',
      })
    const folded = await foldCodexRolloutBootstrap(await rollout(contents))

    expect(folded.state).toMatchObject({
      phase: 'idle',
      idle: { kind: 'done', summary: 'Still bounded.' },
    })
    expect(folded.providerCursor.components.file).toBe(Buffer.byteLength(contents))
  })

  it('does not let late output reopen a terminal epoch', async () => {
    const contents =
      line({ type: 'session_meta', payload: { id: 'thread-late', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T08:30:00.000Z', { turn_id: 'turn-late' }) +
      event('task_complete', '2026-07-19T08:30:01.000Z', { last_agent_message: 'Done.' }) +
      event('token_count', '2026-07-19T08:30:02.000Z') +
      event('agent_message', '2026-07-19T08:30:03.000Z')

    const folded = await foldCodexRolloutBootstrap(await rollout(contents))

    expect(folded.turnEpoch).toBe(1)
    expect(folded.state).toMatchObject({ phase: 'idle', idle: { kind: 'done' } })
    expect(folded.providerAt).toBe('2026-07-19T08:30:01.000Z')
  })

  it('emits zero live edges for frozen restart and exactly one working/terminal pair', async () => {
    const contents =
      line({
        type: 'session_meta',
        payload: { id: 'thread-causal', cwd: '/repo/x', source: 'cli' },
      }) +
      event('task_started', '2026-07-19T08:40:00.000Z', { turn_id: 'turn-frozen' }) +
      event('task_complete', '2026-07-19T08:40:01.000Z', {
        last_agent_message: 'Frozen done.',
      })
    const folded = await foldCodexRolloutBootstrap(await rollout(contents))
    const now = () => '2026-07-19T09:00:00.000Z'
    const config = {
      podiumSessionId: 'podium-causal',
      observerGeneration: 1,
      providerSessionId: 'thread-causal',
      bindingVersion: 1,
      now,
    }
    const lease: ObservationLease = {
      provider: 'codex',
      providerSessionId: 'thread-causal',
      bindingVersion: 1,
      observationGeneration: 1,
    }

    const boot = codexBootstrapObservation(config, folded)
    const first = acceptAgentObservation(null, lease, boot, now())
    expect(first.kind).toBe('snapshot_applied')
    if (first.kind === 'rejected') throw new Error(first.rejectionReason)
    let checkpoint = first.checkpoint

    // Recreating the observer over unchanged history produces the same bootstrap
    // fact and no live edge; the durable dedupe window rejects it deterministically.
    const restart = acceptAgentObservation(
      checkpoint,
      lease,
      codexBootstrapObservation(config, folded),
      now(),
    )
    expect(restart).toEqual({ kind: 'rejected', rejectionReason: 'duplicate_transition' })

    const observer = new CodexCausalCursorObserver(config, folded)
    const outcomes: string[] = []
    const phases: string[] = []
    let offset = folded.providerCursor.components.file ?? 0
    const accept = async (record: unknown, advance: number) => {
      offset += advance
      const observation = await observer.observeRecord(record, offset)
      if (!observation) return null
      const outcome = acceptAgentObservation(checkpoint, lease, observation, now())
      outcomes.push(outcome.kind)
      if (outcome.kind !== 'rejected') {
        checkpoint = outcome.checkpoint
        if (outcome.kind === 'live_transition_accepted') phases.push(observation.nextPhase)
      }
      observer.acknowledge({
        type: 'agentObservationAck',
        sessionId: config.podiumSessionId,
        observerGeneration: config.observerGeneration,
        transitionId: observation.transitionId,
        result: outcome.kind,
        ...(outcome.kind === 'rejected'
          ? { rejectionReason: outcome.rejectionReason }
          : { acceptedCursor: outcome.checkpoint.providerCursor }),
      })
      return observation
    }

    const opened = await accept(
      {
        type: 'event_msg',
        timestamp: '2026-07-19T09:01:00.000Z',
        payload: { type: 'task_started', turn_id: 'turn-live' },
      },
      100,
    )
    expect(opened).toMatchObject({ transitionKind: 'turn_opened', nextPhase: 'working' })

    // The paired user_message is the same logical prompt: cursor refresh only.
    const duplicatePrompt = await accept(
      {
        type: 'event_msg',
        timestamp: '2026-07-19T09:01:00.100Z',
        payload: { type: 'user_message', prompt_id: 'prompt-live', message: 'one turn' },
      },
      100,
    )
    expect(duplicatePrompt).toMatchObject({ transitionKind: 'activity', nextPhase: 'working' })

    const terminal = await accept(
      {
        type: 'event_msg',
        timestamp: '2026-07-19T09:02:00.000Z',
        payload: { type: 'task_complete', last_agent_message: 'Live done.' },
      },
      100,
    )
    expect(terminal).toMatchObject({ transitionKind: 'turn_terminal', nextPhase: 'idle' })

    // Output after the terminal is consumed as diagnostic data and cannot reopen it.
    expect(
      await observer.observeRecord(
        {
          type: 'event_msg',
          timestamp: '2026-07-19T09:02:01.000Z',
          payload: { type: 'token_count' },
        },
        offset + 100,
      ),
    ).toBeNull()

    expect(phases).toEqual(['working', 'idle'])
    expect(outcomes).toEqual([
      'live_transition_accepted',
      'live_refresh_accepted',
      'live_transition_accepted',
    ])
  })

  it('accepts an idle native SessionEnd as a session terminal', async () => {
    const folded = await foldCodexRolloutBootstrap(
      await rollout(
        line({ type: 'session_meta', payload: { id: 'thread-ended', cwd: '/repo/x' } }),
      ),
    )
    const observer = new CodexCausalCursorObserver(
      {
        podiumSessionId: 'podium-ended',
        providerSessionId: 'thread-ended',
        observerGeneration: 1,
        bindingVersion: 1,
      },
      folded,
    )
    const observation = await observer.observeRecord(
      { hook_event_name: 'SessionEnd', session_id: 'thread-ended' },
      (folded.providerCursor.components.file ?? 0) + 100,
    )
    expect(observation).toMatchObject({
      transitionKind: 'session_terminal',
      nextPhase: 'ended',
    })
  })

  it('recovers a lost ack only from an exact durable duplicate', async () => {
    const folded = await foldCodexRolloutBootstrap(
      await rollout(line({ type: 'session_meta', payload: { id: 'thread-ack', cwd: '/repo/x' } })),
    )
    const observer = new CodexCausalCursorObserver(
      {
        podiumSessionId: 'podium-ack',
        providerSessionId: 'thread-ack',
        observerGeneration: 4,
        bindingVersion: 2,
      },
      folded,
    )
    const offset = (folded.providerCursor.components.file ?? 0) + 100
    const observation = await observer.observeRecord(
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-ack' },
      },
      offset,
    )
    if (!observation) throw new Error('missing prompt observation')
    const wrongBinding = {
      type: 'agentObservationAck',
      sessionId: 'podium-ack',
      observerGeneration: 4,
      transitionId: observation.transitionId,
      result: 'live_transition_accepted',
      bindingVersion: 99,
    } as Parameters<typeof observer.acknowledge>[0]
    expect(observer.acknowledge(wrongBinding)).toBe(false)
    expect(observer.waitingForAck).toBe(true)
    const duplicate = {
      type: 'agentObservationAck',
      sessionId: 'podium-ack',
      observerGeneration: 4,
      transitionId: observation.transitionId,
      result: 'rejected',
      rejectionReason: 'duplicate_transition',
      acceptedCursor: observation.providerCursor,
      bindingVersion: 2,
    } as Parameters<typeof observer.acknowledge>[0]
    expect(observer.acknowledge(duplicate)).toBe(true)
    expect(observer.waitingForAck).toBe(false)
    expect(observer.acceptedSnapshot.providerCursor.components.file).toBe(offset)
  })

  it('validates exact session identity before cursor handling and blocks reads behind ack', async () => {
    const folded = await foldCodexRolloutBootstrap(
      await rollout(
        line({ type: 'session_meta', payload: { id: 'thread-bound', cwd: '/repo/x' } }),
      ),
    )
    const rebinds: string[] = []
    const observer = new CodexCausalCursorObserver(
      {
        podiumSessionId: 'podium-bound',
        providerSessionId: 'thread-bound',
        observerGeneration: 3,
        bindingVersion: 2,
        onRebindRequired: (providerSessionId) => rebinds.push(providerSessionId),
      },
      folded,
    )
    const offset = (folded.providerCursor.components.file ?? 0) + 100
    expect(
      await observer.observeRecord(
        { type: 'session_meta', payload: { id: 'foreign-thread' } },
        offset,
      ),
    ).toBeNull()
    expect(
      await observer.observeRecord(
        { hook_event_name: 'SessionEnd', session_id: 'foreign-hook-thread' },
        offset,
      ),
    ).toBeNull()
    expect(rebinds).toEqual(['foreign-thread', 'foreign-hook-thread'])
    expect(observer.readOffset).toBe(offset - 100)
    const prompt = await observer.observeRecord(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'bound-turn' } },
      offset,
    )
    expect(prompt).not.toBeNull()
    expect(observer.waitingForAck).toBe(true)
    expect(
      await observer.observeRecord(
        { type: 'event_msg', payload: { type: 'task_complete' } },
        offset + 100,
      ),
    ).toBeNull()
  })

  it('polls strictly after bootstrap ack and emits one real working/terminal pair', async () => {
    const frozen =
      line({ type: 'session_meta', payload: { id: 'thread-poll', cwd: '/repo/x' } }) +
      event('task_started', '2026-07-19T10:00:00.000Z', { turn_id: 'turn-frozen' }) +
      event('task_complete', '2026-07-19T10:00:01.000Z')
    const path = await rollout(frozen)
    const livePath = join(resolve(path, '..'), 'rollout-2026-07-19T10-00-00-thread-poll.jsonl')
    await rename(path, livePath)
    const observations: AgentObservation[] = []
    const legacyEvents: unknown[] = []
    const rebinds: string[] = []
    const observation = observeCodexState({
      cwd: '/repo/x',
      homeDir: resolve(livePath, '../../../../../..'),
      resumeValue: 'thread-poll',
      pollMs: 10,
      causal: {
        podiumSessionId: 'podium-poll',
        providerSessionId: 'thread-poll',
        observerGeneration: 5,
        bindingVersion: 3,
        acceptedCheckpoint: null,
        onObservation: (value) => observations.push(value),
        onRebindRequired: (providerSessionId) => rebinds.push(providerSessionId),
      },
      onEvents: (events) => legacyEvents.push(...events),
    })
    try {
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      expect(observations[0]?.transitionKind).toBe('snapshot')
      const bootstrap = observations[0]!
      observation.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-poll',
        observerGeneration: 5,
        bindingVersion: 3,
        transitionId: bootstrap.transitionId,
        result: 'snapshot_applied',
        acceptedCursor: bootstrap.providerCursor,
      })
      await appendFile(
        livePath,
        event('task_started', '2026-07-19T10:01:00.000Z', { turn_id: 'turn-live' }),
      )
      await vi.waitFor(() => expect(observations).toHaveLength(2))
      const working = observations[1]!
      expect(working).toMatchObject({ transitionKind: 'turn_opened', nextPhase: 'working' })
      observation.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-poll',
        observerGeneration: 5,
        bindingVersion: 3,
        transitionId: working.transitionId,
        result: 'live_transition_accepted',
        acceptedCursor: working.providerCursor,
      })
      await appendFile(
        livePath,
        event('task_complete', '2026-07-19T10:02:00.000Z', {
          last_agent_message: 'One live turn.',
        }),
      )
      await vi.waitFor(() => expect(observations).toHaveLength(3))
      const terminal = observations[2]!
      expect(terminal).toMatchObject({ transitionKind: 'turn_terminal', nextPhase: 'idle' })
      expect(observations.map((value) => value.transitionKind)).toEqual([
        'snapshot',
        'turn_opened',
        'turn_terminal',
      ])
      expect(observations.slice(1).map((value) => value.nextPhase)).toEqual(['working', 'idle'])
      expect(legacyEvents).toEqual([])
      expect(rebinds).toEqual([])
    } finally {
      observation.stop()
    }
  })

  it('requests exact rebind and emits no state effect for a changed native thread', async () => {
    const sourcePath = await rollout(
      line({ type: 'session_meta', payload: { id: 'thread-after-new', cwd: '/repo/x' } }),
    )
    const livePath = join(resolve(sourcePath, '..'), 'rollout-thread-after-new.jsonl')
    await rename(sourcePath, livePath)
    const observations: AgentObservation[] = []
    const rebinds: string[] = []
    const legacyEvents: unknown[] = []
    const observation = observeCodexState({
      cwd: '/repo/x',
      homeDir: resolve(livePath, '../../../../../..'),
      resumeValue: 'thread-after-new',
      pollMs: 10,
      causal: {
        podiumSessionId: 'podium-new',
        providerSessionId: 'thread-before-new',
        observerGeneration: 8,
        bindingVersion: 4,
        acceptedCheckpoint: null,
        onObservation: (value) => observations.push(value),
        onRebindRequired: (providerSessionId) => rebinds.push(providerSessionId),
      },
      onEvents: (events) => legacyEvents.push(...events),
    })
    try {
      await vi.waitFor(() => expect(rebinds).toEqual(['thread-after-new']))
      expect(observations).toEqual([])
      expect(legacyEvents).toEqual([])
    } finally {
      observation.stop()
    }
  })
})

describe('observeCodexState rollout pinning', () => {
  const jsonl = (lines: unknown[]): string => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`

  const sessionFrom = (
    home: string,
    cwd: string,
    resumeValue: string | undefined,
  ): Promise<{ id?: string; path: string }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        obs.stop()
        reject(new Error('onSession was not called'))
      }, 3000)
      const obs = observeCodexState({
        cwd,
        homeDir: home,
        ...(resumeValue ? { resumeValue } : {}),
        startedAtMs: 0,
        pollMs: 10,
        onSession: (id, path) => {
          clearTimeout(timer)
          obs.stop()
          resolve({ id, path })
        },
        onEvents: () => {},
      })
    })

  it('pins to the resumeValue thread on reattach, ignoring a newer sibling in the same cwd', async () => {
    // The reattach bug: several Codex sessions share a repo cwd. On reattach the
    // observer re-resolved the rollout purely by cwd + newest mtime, so EVERY session
    // latched onto the single most-recent rollout — collapsing them onto one
    // transcript (and one conversation identity, hiding the rest). A reattached
    // session already knows its own thread id; it must pin to THAT rollout.
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-pin-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '25')
    await mkdir(dir, { recursive: true })
    const cwd = '/repo/multi'

    const older = join(dir, 'rollout-2026-06-25T10-00-00-sessA.jsonl')
    await writeFile(
      older,
      jsonl([{ type: 'session_meta', payload: { id: 'sessA', cwd, source: 'cli' } }]),
    )
    const newer = join(dir, 'rollout-2026-06-25T11-00-00-sessB.jsonl')
    await writeFile(
      newer,
      jsonl([{ type: 'session_meta', payload: { id: 'sessB', cwd, source: 'cli' } }]),
    )
    await utimes(older, new Date(1000), new Date(1000))
    await utimes(newer, new Date(2000), new Date(2000))

    const found = await sessionFrom(home, cwd, 'sessA')
    expect(found.id).toBe('sessA')
    expect(found.path).toBe(older)
  })

  it('does not grab a cwd sibling on reattach without a resume value or start floor', async () => {
    // The reattach signature is: no resumeValue (the session never got a rollout —
    // e.g. an empty pane the user never prompted) AND no startedAtMs (only a fresh
    // spawn passes one). Discovering by cwd here would latch onto an unrelated
    // sibling's rollout and re-corrupt the session. The observer must stay idle
    // until it has something authoritative to bind to.
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-noref-'))
    const dir = join(home, '.codex', 'sessions', '2026', '06', '25')
    await mkdir(dir, { recursive: true })
    const cwd = '/repo/empty-pane'
    await writeFile(
      join(dir, 'rollout-2026-06-25T11-00-00-sibling.jsonl'),
      jsonl([{ type: 'session_meta', payload: { id: 'sibling', cwd, source: 'cli' } }]),
    )

    let announced: { id?: string; path: string } | undefined
    const obs = observeCodexState({
      cwd,
      homeDir: home,
      // neither resumeValue nor startedAtMs — the reattach-without-ref shape
      pollMs: 10,
      onSession: (id, path) => {
        announced = { id, path }
      },
      onEvents: () => {},
    })
    await new Promise((r) => setTimeout(r, 200))
    obs.stop()
    expect(announced).toBeUndefined()
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
    const db = openDatabase(join(home, '.codex', 'state_5.sqlite'))
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

describe('findLiveCodexRollout sibling disambiguation (nearest-after floor)', () => {
  it('binds the rollout booted nearest after the floor, not a later sibling', async () => {
    // Codex creates the rollout file LAZILY (first prompt), so by the time a
    // reattached observer discovers by cwd there may be several candidates past
    // the floor. The session's own rollout is the one whose session_meta boot
    // timestamp is CLOSEST AFTER its spawn; a sibling pane spawned later boots
    // later. Newest-first would cross-wire this pane onto the sibling.
    const sessions = await mkdtemp(join(tmpdir(), 'podium-codex-nearest-'))
    const dir = join(sessions, '2026', '07', '06')
    await mkdir(dir, { recursive: true })
    const cwd = '/repo/podium'
    const spawnAt = Date.parse('2026-07-06T10:00:00.000Z')

    const own = join(dir, 'rollout-2026-07-06T10-00-02-own.jsonl')
    await writeFile(
      own,
      `${JSON.stringify({
        timestamp: '2026-07-06T10:00:02.000Z',
        type: 'session_meta',
        payload: { id: 'own', cwd, source: 'cli', timestamp: '2026-07-06T10:00:02.000Z' },
      })}\n`,
    )
    const sibling = join(dir, 'rollout-2026-07-06T12-00-01-sibling.jsonl')
    await writeFile(
      sibling,
      `${JSON.stringify({
        timestamp: '2026-07-06T12:00:01.000Z',
        type: 'session_meta',
        payload: { id: 'sibling', cwd, source: 'cli', timestamp: '2026-07-06T12:00:01.000Z' },
      })}\n`,
    )

    const found = await findLiveCodexRollout(sessions, cwd, spawnAt)
    expect(found?.id).toBe('own')
    expect(found?.path).toBe(own)
  })
})

describe('codexBootEvents (resumed session classification)', () => {
  const rec = (ptype: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: ptype, ...extra } })
  const response = (ptype: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: ptype, ...extra } })
  const meta = (id: string) =>
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo/x', source: 'cli' } })

  const homeWithRollout = async (id: string, lines: string[]): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), 'podium-codex-boot-'))
    const dir = join(home, '.codex', 'sessions', '2026', '07', '06')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `rollout-2026-07-06T10-00-00-${id}.jsonl`), `${lines.join('\n')}\n`)
    return home
  }

  it('resolves the rollout via filename fallback when the state DB is absent', async () => {
    const home = await homeWithRollout('th-1', [
      meta('th-1'),
      rec('task_complete', '2026-07-06T10:05:00.000Z', { last_agent_message: 'All done.' }),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-1',
      homeDir: home,
    })
    expect(events[0]?.kind).toBe('turn_completed')
  })

  it('stamps an idle seed with the task_complete record time, not the file mtime', async () => {
    // Mid-turn the rollout mtime is "now"; stamping mtime restamps the session's
    // recency to the reattach moment. The record's own timestamp is the truth.
    const home = await homeWithRollout('th-2', [
      meta('th-2'),
      rec('task_complete', '2026-07-06T10:05:00.000Z', { last_agent_message: 'Done.' }),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-2',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'done', summary: 'Done.' },
        at: '2026-07-06T10:05:00.000Z',
      },
    ])
  })

  it('seeds WORKING when the rollout has an open turn (task_started after the last task_complete)', async () => {
    // A daemon restart mid-turn must not flap the session to "idle done <stale
    // summary>": the last task_complete belongs to a PREVIOUS turn.
    const home = await homeWithRollout('th-3', [
      meta('th-3'),
      rec('task_complete', '2026-07-06T10:05:00.000Z', { last_agent_message: 'Earlier turn.' }),
      rec('user_message', '2026-07-06T10:10:00.000Z', { message: 'next task please' }),
      rec('task_started', '2026-07-06T10:10:00.500Z'),
      rec('token_count', '2026-07-06T10:10:05.000Z'),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-3',
      homeDir: home,
    })
    expect(events).toEqual([{ kind: 'prompt_submitted', at: '2026-07-06T10:10:00.500Z' }])
  })

  it('seeds NEEDS_USER when the open turn ends on an unresolved request_user_input call', async () => {
    const home = await homeWithRollout('th-question', [
      meta('th-question'),
      rec('task_started', '2026-07-13T08:43:09.089Z'),
      response('function_call', '2026-07-13T08:47:06.776Z', {
        name: 'request_user_input',
        call_id: 'call-q',
        arguments: JSON.stringify({
          questions: [{ question: 'Where should workflow defaults apply?' }],
        }),
      }),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-question',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: 'Where should workflow defaults apply?',
        at: '2026-07-13T08:47:06.776Z',
      },
    ])
  })

  it('keeps an answered request_user_input turn working until task completion', async () => {
    const home = await homeWithRollout('th-answered', [
      meta('th-answered'),
      rec('task_started', '2026-07-13T08:43:09.089Z'),
      response('function_call', '2026-07-13T08:47:06.776Z', {
        name: 'request_user_input',
        call_id: 'call-q',
        arguments: JSON.stringify({ questions: [{ question: 'Pick one?' }] }),
      }),
      response('function_call_output', '2026-07-13T08:48:00.000Z', {
        call_id: 'call-q',
        output: '{"choice":"first"}',
      }),
      rec('token_count', '2026-07-13T08:48:01.000Z'),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-answered',
      homeDir: home,
    })
    expect(events).toEqual([{ kind: 'prompt_submitted', at: '2026-07-13T08:43:09.089Z' }])
  })

  it('classifies an aborted last turn as interrupted', async () => {
    const home = await homeWithRollout('th-4', [
      meta('th-4'),
      rec('task_started', '2026-07-06T10:00:01.000Z'),
      rec('turn_aborted', '2026-07-06T10:02:00.000Z'),
    ])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-4',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'interrupted', summary: 'turn aborted' },
        at: '2026-07-06T10:02:00.000Z',
      },
    ])
  })

  it('falls back to session_started when the rollout has no turn records', async () => {
    const home = await homeWithRollout('th-5', [meta('th-5')])
    const events = await codexStateProvider.bootEvents!({
      cwd: '/repo/x',
      resumeValue: 'th-5',
      homeDir: home,
    })
    expect(events).toEqual([{ kind: 'session_started' }])
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
