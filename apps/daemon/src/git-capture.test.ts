import { asSessionId } from '@podium/model'
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
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    cap.onHookPayload(asSessionId('s1'), post())
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
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    head = 'bbb' // the Bash call committed
    cap.onHookPayload(asSessionId('s1'), post())
    await settle()
    const commitMsgs = sent.filter((m) => m.commits)
    expect(commitMsgs).toHaveLength(1)
    expect(commitMsgs[0]?.commits).toEqual(['sha1', 'sha2'])
  })

  it('attributes commits around a Grok camelCase Bash call', async () => {
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
    // Grok Build native hooks: camelCase hookEventName + toolName.
    cap.onHookPayload(asSessionId('s1'), { hookEventName: 'PreToolUse', toolName: 'Bash', cwd: '/repo' })
    await settle()
    head = 'bbb'
    cap.onHookPayload(asSessionId('s1'), { hookEventName: 'PostToolUse', toolName: 'Bash', cwd: '/repo' })
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
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    head = 'bbb'
    cap.onHookPayload(asSessionId('s1'), post())
    await settle()
    expect(sent.filter((m) => m.commits)[0]?.commits).toEqual(['bbb'])
  })

  it('registers a session once via SessionStart when the cwd is a repo', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload(asSessionId('s1'), { hook_event_name: 'SessionStart', cwd: '/repo' })
    cap.onHookPayload(asSessionId('s1'), { hook_event_name: 'SessionStart', cwd: '/repo' })
    await settle()
    expect(sent).toEqual([{ type: 'sessionGitActivity', sessionId: 's1' }])
  })

  it('never registers a session outside git', async () => {
    const { cap, sent } = capture({})
    cap.onHookPayload(asSessionId('s1'), { hook_event_name: 'SessionStart', cwd: '/not-a-repo' })
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
    cap.onHookPayload(asSessionId('s1'), { hook_event_name: 'SessionStart', cwd: '/repo' })
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    run.mockClear()

    cap.onHookPayload(asSessionId('s1'), pre('BashOutput'))
    cap.onHookPayload(asSessionId('s1'), post('BashOutput'))
    await settle()
    expect(run).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'sessionGitActivity', sessionId: 's1' }])
  })

  it('reports edit-tool touches once per file', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload(asSessionId('s1'), post('Edit', { file_path: '/repo/a.ts' }))
    cap.onHookPayload(asSessionId('s1'), post('Edit', { file_path: '/repo/a.ts' }))
    cap.onHookPayload(asSessionId('s1'), post('Write', { file_path: '/repo/b.ts' }))
    await settle()
    const touches = sent.filter((m) => m.touched)
    expect(touches.map((m) => m.touched)).toEqual([['/repo/a.ts'], ['/repo/b.ts']])
  })

  it('ignores non-shell, non-edit tools and missing cwd', async () => {
    const { cap, sent } = capture({ 'rev-parse HEAD': 'aaa' })
    cap.onHookPayload(asSessionId('s1'), post('Read', { file_path: '/repo/a.ts' }))
    cap.onHookPayload(asSessionId('s1'), { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
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
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    cap.clearSession(asSessionId('s1'))
    head = 'bbb'
    cap.onHookPayload(asSessionId('s1'), post())
    await settle()
    expect(sent.filter((m) => m.commits)).toEqual([])
  })

  it('drops a queued post-tool result when clear/rebind lands while reads are pending', async () => {
    // Deterministic deferred runner: hold the post rev-parse until the test
    // releases it, so the turn can complete first. The old result must not
    // attribute to the replacement process reusing the same session ID.
    let releasePost!: (value: string | null) => void
    const postGate = new Promise<string | null>((resolve) => {
      releasePost = resolve
    })
    let calls = 0
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run: async (args, _cwd) => {
        const key = args.join(' ')
        if (key === 'rev-parse HEAD') {
          calls += 1
          // First call is pre (aaa); second is post (held).
          if (calls === 1) return 'aaa'
          return postGate
        }
        if (key === 'rev-list --reverse aaa..bbb') return 'sha1'
        return null
      },
    })
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    cap.onHookPayload(asSessionId('s1'), post())
    // Post read is now pending inside the chain.
    await new Promise((r) => setTimeout(r, 0))
    cap.clearSession(asSessionId('s1'))
    // Rebind: same session ID, new generation. Even a successful post read
    // for the old generation must not send.
    releasePost('bbb')
    await settle()
    await settle()
    expect(sent.filter((m) => m.commits)).toEqual([])
  })

  it('delivers a deferred post-tool result exactly once after turn completion', async () => {
    // Hold post rev-parse/rev-list, let the (simulated) turn complete, then
    // release: exactly one commit attribution, no double count on replay.
    let releasePost!: (value: string | null) => void
    let releaseList!: (value: string | null) => void
    const postGate = new Promise<string | null>((resolve) => {
      releasePost = resolve
    })
    const listGate = new Promise<string | null>((resolve) => {
      releaseList = resolve
    })
    let revParseCalls = 0
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({
      send: (msg) => sent.push(msg),
      run: async (args) => {
        const key = args.join(' ')
        if (key === 'rev-parse HEAD') {
          revParseCalls += 1
          if (revParseCalls === 1) return 'aaa'
          return postGate
        }
        if (key.startsWith('rev-list')) return listGate
        return null
      },
    })
    cap.onHookPayload(asSessionId('s1'), pre())
    await settle()
    cap.onHookPayload(asSessionId('s1'), post())
    await new Promise((r) => setTimeout(r, 0))
    // Turn completes while reads are held (no gate interaction here — this
    // unit proves the capture half holds and releases exactly once).
    releasePost('bbb')
    await new Promise((r) => setTimeout(r, 0))
    releaseList('sha1\nsha2')
    await settle()
    await settle()
    const commits = sent.filter((m) => m.commits)
    expect(commits).toHaveLength(1)
    expect(commits[0]?.commits).toEqual(['sha1', 'sha2'])
  })

  // Per-fence pins: each generation fence below must fail when ONLY its own
  // check is neutered. Intermediate fences assert on git read counts (they
  // save stale reads); terminal fences assert on absence of send. The two
  // pre-start duplicates that used to sit inside register/post steps were
  // removed — fence A is the only pre-start fence (see git-capture.ts).

  it('fence A drops a queued register before it starts (no git read issued)', async () => {
    const run = vi.fn(async (): Promise<string | null> => 'aaa')
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({ send: (msg) => sent.push(msg), run })
    const sid = asSessionId('s-fence-A')
    cap.onHookPayload(sid, { hook_event_name: 'SessionStart', cwd: '/repo' })
    // Synchronous clear: the enqueued step is still queued on a resolved tail
    // and has not run yet. Fence A must drop it before its first git read.
    cap.clearSession(sid)
    await settle()
    await settle()
    expect(run).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('fence C drops a register when clear lands while its rev-parse is pending', async () => {
    let release!: (value: string | null) => void
    const gate = new Promise<string | null>((resolve) => {
      release = resolve
    })
    const run = vi.fn(async (): Promise<string | null> => gate)
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({ send: (msg) => sent.push(msg), run })
    const sid = asSessionId('s-fence-C')
    cap.onHookPayload(sid, { hook_event_name: 'SessionStart', cwd: '/repo' })
    // Wait until the step started (its rev-parse issued) so fence A already passed.
    for (let i = 0; i < 100 && run.mock.calls.length < 1; i += 1) {
      await settle()
    }
    expect(run.mock.calls.length).toBe(1)
    cap.clearSession(sid)
    release('aaa')
    await settle()
    await settle()
    expect(sent).toEqual([])
  })

  it('fence E drops a post step waiting on pre HEAD without issuing the post read', async () => {
    let releaseOpened!: (value: string | null) => void
    const openedGate = new Promise<string | null>((resolve) => {
      releaseOpened = resolve
    })
    let calls = 0
    const run = vi.fn(async (): Promise<string | null> => {
      calls += 1
      if (calls === 1) return openedGate // preHead (held)
      if (calls === 2) return 'aaa' // register rev-parse (fast)
      return 'bbb' // post rev-parse — must never be issued once E drops
    })
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({ send: (msg) => sent.push(msg), run })
    const sid = asSessionId('s-fence-E')
    cap.onHookPayload(sid, pre())
    for (let i = 0; i < 100 && calls < 2; i += 1) {
      await settle()
    }
    expect(calls).toBe(2)
    await settle()
    await settle()
    cap.onHookPayload(sid, post())
    await settle()
    await settle()
    // Post step started and is parked on `await opened`; no post read yet.
    expect(calls).toBe(2)
    cap.clearSession(sid)
    releaseOpened('aaa')
    await settle()
    await settle()
    await settle()
    expect(run.mock.calls.length).toBe(2)
    expect(sent.filter((m) => m.commits)).toEqual([])
  })

  it('fence F drops a post step during its post read without issuing rev-list', async () => {
    let releaseAfter!: (value: string | null) => void
    const afterGate = new Promise<string | null>((resolve) => {
      releaseAfter = resolve
    })
    let calls = 0
    const run = vi.fn(async (args: string[]): Promise<string | null> => {
      if (args.join(' ').startsWith('rev-list')) return 'sha1' // must never be reached
      calls += 1
      if (calls <= 2) return 'aaa' // preHead + register (fast)
      return afterGate // post rev-parse (held)
    })
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({ send: (msg) => sent.push(msg), run })
    const sid = asSessionId('s-fence-F')
    cap.onHookPayload(sid, pre())
    for (let i = 0; i < 100 && calls < 2; i += 1) {
      await settle()
    }
    await settle()
    await settle()
    cap.onHookPayload(sid, post())
    for (let i = 0; i < 100 && calls < 3; i += 1) {
      await settle()
    }
    expect(calls).toBe(3)
    cap.clearSession(sid)
    releaseAfter('bbb')
    await settle()
    await settle()
    await settle()
    expect(run.mock.calls.some((c) => (c[0] as string[]).join(' ').startsWith('rev-list'))).toBe(false)
    expect(sent.filter((m) => m.commits)).toEqual([])
  })

  it('fence G drops a post step during rev-list without attributing stale shas', async () => {
    let releaseList!: (value: string | null) => void
    const listGate = new Promise<string | null>((resolve) => {
      releaseList = resolve
    })
    let revParseCalls = 0
    const run = vi.fn(async (args: string[]): Promise<string | null> => {
      const key = args.join(' ')
      if (key.startsWith('rev-list')) return listGate // held
      revParseCalls += 1
      if (revParseCalls <= 2) return 'aaa' // preHead + register
      return 'bbb' // post rev-parse
    })
    const sent: SessionGitActivityOut[] = []
    const cap = createGitCapture({ send: (msg) => sent.push(msg), run })
    const sid = asSessionId('s-fence-G')
    cap.onHookPayload(sid, pre())
    for (let i = 0; i < 100 && revParseCalls < 2; i += 1) {
      await settle()
    }
    await settle()
    await settle()
    cap.onHookPayload(sid, post())
    for (let i = 0; i < 100; i += 1) {
      await settle()
      if (run.mock.calls.some((c) => (c[0] as string[]).join(' ').startsWith('rev-list'))) break
    }
    expect(run.mock.calls.some((c) => (c[0] as string[]).join(' ').startsWith('rev-list'))).toBe(true)
    cap.clearSession(sid)
    releaseList('sha1\nsha2')
    await settle()
    await settle()
    await settle()
    expect(sent.filter((m) => m.commits)).toEqual([])
  })
})
