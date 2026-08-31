import { mkdtemp, mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokSessionPaths } from './grok.js'
import { locateGrokChatHistory, locateGrokSessionPaths } from './grok-locate.js'

// The wrong-bucket bug: Grok buckets sessions by the cwd the conversation was
// CREATED under, while session.cwd is the current worktree. The locator must
// find chat_history.jsonl regardless of the current cwd.
describe('locateGrokSessionPaths', () => {
  async function seedHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'podium-grok-locate-'))
  }
  async function seedSession(home: string, cwd: string, id: string): Promise<string> {
    const paths = grokSessionPaths({ cwd, sessionId: id, homeDir: home })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id, cwd } }))
    await writeFile(paths.chatHistoryPath, `${JSON.stringify({ type: 'user', content: 'hello' })}\n`)
    return paths.chatHistoryPath
  }

  it('prefers the current product transcript authority over a legacy chat_history', async () => {
    const home = await seedHome()
    await seedSession(home, '/repo/main', 'sess-current')
    const transcriptRoot = join(home, 'product-transcripts')
    const current = join(transcriptRoot, 'project-id', 'sess-current.jsonl')
    await mkdir(join(transcriptRoot, 'project-id'), { recursive: true })
    await writeFile(current, `${JSON.stringify({ type: 'user', content: 'current' })}\n`)

    expect(
      await locateGrokChatHistory({
        cwd: '/repo/main',
        sessionId: 'sess-current',
        homeDir: home,
        transcriptRoot,
      }),
    ).toBe(current)
  })

  it('accepts a confined recorded current-authority pathHint without scanning the root', async () => {
    const home = await seedHome()
    const transcriptRoot = join(home, 'product-transcripts')
    const current = join(transcriptRoot, 'recorded', 'sess-recorded.jsonl')
    await mkdir(join(transcriptRoot, 'recorded'), { recursive: true })
    await writeFile(current, `${JSON.stringify({ type: 'assistant', content: 'recorded' })}\n`)
    expect(
      await locateGrokChatHistory({
        cwd: '/repo/main',
        sessionId: 'sess-recorded',
        pathHint: current,
        homeDir: home,
        transcriptRoot,
      }),
    ).toBe(current)
  })

  it('rejects a traversal-shaped hint that does not have one project directory', async () => {
    const home = await seedHome()
    const transcriptRoot = join(home, 'product-transcripts')
    await mkdir(join(transcriptRoot, 'project'), { recursive: true })
    const escaped = join(transcriptRoot, 'sess-traversal.jsonl')
    await writeFile(escaped, '{}\n')
    expect(
      await locateGrokChatHistory({
        cwd: '/repo/main',
        sessionId: 'sess-traversal',
        pathHint: transcriptRoot + '/project/../sess-traversal.jsonl',
        homeDir: home,
        transcriptRoot,
      }),
    ).toBeNull()
  })

  it('rejects a current-authority hint outside transcriptRoot', async () => {
    const home = await seedHome()
    const transcriptRoot = join(home, 'product-transcripts')
    const outside = join(home, 'outside', 'sess-outside.jsonl')
    await mkdir(transcriptRoot, { recursive: true })
    await mkdir(join(home, 'outside'), { recursive: true })
    await writeFile(outside, '{}\n')
    expect(
      await locateGrokChatHistory({
        cwd: '/repo/main',
        sessionId: 'sess-outside',
        pathHint: outside,
        homeDir: home,
        transcriptRoot,
      }),
    ).toBeNull()
  })

  it('rejects a root-scanned transcript symlink that escapes transcriptRoot', async () => {
    const home = await seedHome()
    const transcriptRoot = join(home, 'product-transcripts')
    const project = join(transcriptRoot, 'project')
    const outside = join(home, 'outside', 'sess-symlink.jsonl')
    await mkdir(project, { recursive: true })
    await mkdir(join(home, 'outside'), { recursive: true })
    await writeFile(outside, '{}\n')
    await symlink(outside, join(project, 'sess-symlink.jsonl'))
    expect(
      await locateGrokChatHistory({
        cwd: '/repo/main',
        sessionId: 'sess-symlink',
        homeDir: home,
        transcriptRoot,
      }),
    ).toBeNull()
  })

  it('resolves the exact current-cwd bucket when the file is there', async () => {
    const home = await seedHome()
    const path = await seedSession(home, '/repo/main', 'sess-1')
    expect(
      await locateGrokChatHistory({ cwd: '/repo/main', sessionId: 'sess-1', homeDir: home }),
    ).toBe(path)
  })

  it('sweeps other buckets when cwd and the Grok session bucket disagree', async () => {
    const home = await seedHome()
    // Stored under the git root; Podium's session.cwd is the worktree.
    const path = await seedSession(home, '/repo', 'sess-2')
    expect(
      await locateGrokChatHistory({
        cwd: '/repo/.worktrees/issue-912-unread-indicators',
        sessionId: 'sess-2',
        homeDir: home,
      }),
    ).toBe(path)
  })

  it('finds the file even when the original worktree dir no longer exists', async () => {
    const home = await seedHome()
    const path = await seedSession(home, '/gone/worktree', 'sess-3')
    expect(
      await locateGrokChatHistory({ cwd: '/somewhere/else', sessionId: 'sess-3', homeDir: home }),
    ).toBe(path)
  })

  it('prefers the newest file when the same id exists in two buckets', async () => {
    const home = await seedHome()
    const older = await seedSession(home, '/a', 'sess-4')
    const newer = await seedSession(home, '/b', 'sess-4')
    const past = new Date(Date.now() - 60_000)
    await utimes(older, past, past)
    expect(
      await locateGrokChatHistory({ cwd: '/c', sessionId: 'sess-4', homeDir: home }),
    ).toBe(newer)
  })

  it('a recorded summary.json pathHint short-circuits; a stale one falls through', async () => {
    const home = await seedHome()
    const real = await seedSession(home, '/origin', 'sess-hint')
    const hint = grokSessionPaths({ cwd: '/origin', sessionId: 'sess-hint', homeDir: home }).summaryPath
    expect(
      await locateGrokChatHistory({
        cwd: '/elsewhere',
        sessionId: 'sess-hint',
        pathHint: hint,
        homeDir: home,
      }),
    ).toBe(real)
    expect(
      await locateGrokChatHistory({
        cwd: '/elsewhere',
        sessionId: 'sess-hint',
        pathHint: join(home, 'no', 'longer', 'there', 'summary.json'),
        homeDir: home,
      }),
    ).toBe(real)
  })

  it("a pathHint whose session dir is not this session's id is ignored", async () => {
    const home = await seedHome()
    const real = await seedSession(home, '/origin', 'sess-hint2')
    const impostor = await seedSession(home, '/origin', 'other-session')
    const hint = grokSessionPaths({
      cwd: '/origin',
      sessionId: 'other-session',
      homeDir: home,
    }).summaryPath
    expect(
      await locateGrokChatHistory({
        cwd: '/elsewhere',
        sessionId: 'sess-hint2',
        pathHint: impostor,
        homeDir: home,
      }),
    ).toBe(real)
    expect(
      await locateGrokChatHistory({
        cwd: '/elsewhere',
        sessionId: 'sess-hint2',
        pathHint: hint,
        homeDir: home,
      }),
    ).toBe(real)
  })

  it('returns null when the session exists nowhere (and when sessions/ is absent)', async () => {
    const home = await seedHome()
    expect(
      await locateGrokSessionPaths({ cwd: '/x', sessionId: 'missing', homeDir: home }),
    ).toBeNull()
    await seedSession(home, '/x', 'other')
    expect(
      await locateGrokChatHistory({ cwd: '/x', sessionId: 'missing', homeDir: home }),
    ).toBeNull()
  })
})
