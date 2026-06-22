import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileIdFor, resolveFileChain } from './file-chain.js'

describe('fileIdFor', () => {
  it('is stable and path-derived (no raw path leak)', () => {
    const id = fileIdFor('/home/u/.claude/projects/x/abc.jsonl')
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    expect(fileIdFor('/home/u/.claude/projects/x/abc.jsonl')).toBe(id)
  })
})

describe('resolveFileChain', () => {
  it('orders claude bucket files oldest→newest by mtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    process.env.HOME = home
    const slug = '/work/repo'.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    await mkdir(dir, { recursive: true })
    const older = join(dir, 'older.jsonl')
    const newer = join(dir, 'newer.jsonl')
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    await utimes(older, new Date(1000), new Date(1000))
    await utimes(newer, new Date(2000), new Date(2000))
    const chain = await resolveFileChain({ agentKind: 'claude-code', cwd: '/work/repo' })
    expect(chain.map((c) => c.path)).toEqual([older, newer])
  })

  it('breaks claude mtime ties deterministically by filename ascending', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    process.env.HOME = home
    const slug = '/work/repo'.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    await mkdir(dir, { recursive: true })
    const bbb = join(dir, 'bbb.jsonl')
    const aaa = join(dir, 'aaa.jsonl')
    await writeFile(bbb, '{}\n')
    await writeFile(aaa, '{}\n')
    // Identical mtimes — only the filename tiebreak can order these.
    await utimes(bbb, new Date(5000), new Date(5000))
    await utimes(aaa, new Date(5000), new Date(5000))
    const chain = await resolveFileChain({ agentKind: 'claude-code', cwd: '/work/repo' })
    expect(chain.map((c) => c.path)).toEqual([aaa, bbb])
  })

  it('resolves a one-entry chain for cursor from cwd + chatId', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const cwd = '/work/repo'
    const chatId = 'chat-123'
    const { cursorSessionPaths } = await import('../cursor/paths.js')
    const transcriptPath = cursorSessionPaths({ cwd, chatId, homeDir: home }).transcriptPath
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, '{}\n')
    const chain = await resolveFileChain({
      agentKind: 'cursor',
      cwd,
      resumeValue: chatId,
      homeDir: home,
    })
    expect(chain).toEqual([{ path: transcriptPath, fileId: fileIdFor(transcriptPath) }])
  })

  it('resolves a one-entry chain for grok from cwd + sessionId', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const cwd = '/work/repo'
    const sessionId = 'sess-456'
    const { grokSessionPaths } = await import('../agent-state/grok.js')
    const chatHistoryPath = grokSessionPaths({ cwd, sessionId, homeDir: home }).chatHistoryPath
    await mkdir(dirname(chatHistoryPath), { recursive: true })
    await writeFile(chatHistoryPath, '{}\n')
    const chain = await resolveFileChain({
      agentKind: 'grok',
      cwd,
      resumeValue: sessionId,
      homeDir: home,
    })
    expect(chain).toEqual([{ path: chatHistoryPath, fileId: fileIdFor(chatHistoryPath) }])
  })

  it('resolves a one-entry chain for codex via the rollout filename fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const threadId = 'thread-789'
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    // The filename fallback matches a rollout whose name includes the resume value.
    const rollout = join(dir, `rollout-2026-06-16T16-11-26-${threadId}.jsonl`)
    await writeFile(rollout, '{}\n')
    const chain = await resolveFileChain({
      agentKind: 'codex',
      cwd: '/work/repo',
      resumeValue: threadId,
      homeDir: home,
    })
    expect(chain).toEqual([{ path: rollout, fileId: fileIdFor(rollout) }])
  })

  it('returns [] for codex when the rollout cannot be found', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const chain = await resolveFileChain({
      agentKind: 'codex',
      cwd: '/work/repo',
      resumeValue: 'missing-thread',
      homeDir: home,
    })
    expect(chain).toEqual([])
  })

  it('returns [] for grok/cursor when the file is missing on disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    expect(
      await resolveFileChain({
        agentKind: 'cursor',
        cwd: '/work/repo',
        resumeValue: 'no-such-chat',
        homeDir: home,
      }),
    ).toEqual([])
    expect(
      await resolveFileChain({
        agentKind: 'grok',
        cwd: '/work/repo',
        resumeValue: 'no-such-sess',
        homeDir: home,
      }),
    ).toEqual([])
  })

  it('returns [] for a file-based harness when resumeValue is missing', async () => {
    expect(await resolveFileChain({ agentKind: 'cursor', cwd: '/x' })).toEqual([])
    expect(await resolveFileChain({ agentKind: 'grok', cwd: '/x' })).toEqual([])
    expect(await resolveFileChain({ agentKind: 'codex', cwd: '/x' })).toEqual([])
  })

  it('still returns [] for opencode (handled by a separate DB adapter)', async () => {
    expect(await resolveFileChain({ agentKind: 'opencode', cwd: '/x', resumeValue: 'p' })).toEqual(
      [],
    )
  })
})
