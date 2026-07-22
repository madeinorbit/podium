import { describe, expect, it, vi } from 'vitest'
import { createGitCapture, type SessionGitActivityOut } from './git-capture'

/** Scripted fake git: maps `args.join(' ')` → output (null = failure). */
const capture = (script: Record<string, string | null>) => {
  const sent: SessionGitActivityOut[] = []
  const cap = createGitCapture({
    send: (msg) => sent.push(msg),
    run: async (args) => script[args.join(' ')] ?? null,
  })
  return { cap, sent }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

const pre = (tool = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  cwd: '/repo',
})
const post = (tool = 'Bash', input?: Record<string, unknown>) => ({
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  cwd: '/repo',
  ...(input ? { tool_input: input } : {}),
})

describe('git-capture', () => {
  it('reports the HEAD delta around one Bash call as attributed commits', async () => {
    const { cap, sent } = capture({
      'rev-parse HEAD': 'aaa',
      'rev-list --reverse aaa..bbb': 'sha1\nsha2',
    })
    cap.onHookPayload('s1', pre())
    await settle()
    cap.onHookPayload('s1', post())
    await settle()
    // pre read 'aaa'; post read 'aaa' again in this script → no delta.
    expect(sent.filter((m) => m.commits)).toEqual([])
  })

  it('detects a moved HEAD and sends oldest-first shas', async () => {
    let head = 'aaa'
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run: async (args) => {
        if (args.join(' ') === 'rev-parse HEAD') return head
        if (args.join(' ') === 'rev-list --reverse aaa..bbb') return 'sha1\nsha2'
        return null
      },
    })
    cap.onHookPayload('s1', pre())
    await settle()
    head = 'bbb' // the Bash call committed
    cap.onHookPayload('s1', post())
    await settle()
    const commitMsgs = sent.filter((m) => m.commits)
    expect(commitMsgs).toHaveLength(1)
    expect(commitMsgs[0]?.commits).toEqual(['sha1', 'sha2'])
  })

  it('falls back to the new head when rev-list fails (history rewrite)', async () => {
    let head = 'aaa'
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run: async (args) => (args.join(' ') === 'rev-parse HEAD' ? head : null),
    })
    cap.onHookPayload('s1', pre())
    await settle()
    head = 'bbb'
    cap.onHookPayload('s1', post())
    await settle()
    expect(sent.filter((m) => m.commits)[0]?.commits).toEqual(['bbb'])
  })

  it('registers a session once via SessionStart when the cwd is a repo', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload('s1', { hook_event_name: 'SessionStart', cwd: '/repo' })
    cap.onHookPayload('s1', { hook_event_name: 'SessionStart', cwd: '/repo' })
    await settle()
    expect(sent).toEqual([{ type: 'sessionGitActivity', sessionId: 's1' }])
  })

  it('never registers a session outside git', async () => {
    const { cap, sent } = capture({})
    cap.onHookPayload('s1', { hook_event_name: 'SessionStart', cwd: '/not-a-repo' })
    await settle()
    expect(sent).toEqual([])
  })

  it('does not launch Git processes around BashOutput polling', async () => {
    const sent: SessionGitActivityOut[] = []
    const run = vi.fn(async () => 'aaa')
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run,
    })
    cap.onHookPayload('s1', { hook_event_name: 'SessionStart', cwd: '/repo' })
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    run.mockClear()

    cap.onHookPayload('s1', pre('BashOutput'))
    cap.onHookPayload('s1', post('BashOutput'))
    await settle()
    expect(run).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'sessionGitActivity', sessionId: 's1' }])
  })

  it('reports edit-tool touches once per file', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload('s1', post('Edit', { file_path: '/repo/a.ts' }))
    cap.onHookPayload('s1', post('Edit', { file_path: '/repo/a.ts' }))
    cap.onHookPayload('s1', post('Write', { file_path: '/repo/b.ts' }))
    await settle()
    const touches = sent.filter((m) => m.touched)
    expect(touches.map((m) => m.touched)).toEqual([['/repo/a.ts'], ['/repo/b.ts']])
  })

  it('ignores non-shell, non-edit tools and missing cwd', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload('s1', post('Read', { file_path: '/repo/a.ts' }))
    cap.onHookPayload('s1', { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    await settle()
    expect(sent).toEqual([])
  })

  it('clearSession drops the bracket so a stale pre never pairs', async () => {
    let head = 'aaa'
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run: async (args) => (args.join(' ') === 'rev-parse HEAD' ? head : null),
    })
    cap.onHookPayload('s1', pre())
    await settle()
    cap.clearSession('s1')
    head = 'bbb'
    cap.onHookPayload('s1', post())
    await settle()
    expect(sent.filter((m) => m.commits)).toEqual([])
  })
})
