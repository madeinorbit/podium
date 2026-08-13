import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug } from './agent-state/claude-locate.js'
import { grokSessionPaths } from './agent-state/grok.js'
import { resolveFileChain, transcriptSourceFor } from './transcript-source.js'

// End-to-end regression for "transcripts can't be loaded after the session moved
// to a new worktree": the read path receives the RESTAMPED cwd but the JSONL
// lives in the bucket of the creation-time cwd.
describe('transcript read after a cwd restamp', () => {
  async function seed(): Promise<{ home: string; path: string }> {
    const home = await mkdtemp(join(tmpdir(), 'podium-moved-'))
    const dir = join(home, '.claude', 'projects', claudeProjectSlug('/repo/worktrees/original'))
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'sess-moved.jsonl')
    await writeFile(
      path,
      `${[
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello from the old worktree' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'still here' }] },
        }),
      ].join('\n')}\n`,
    )
    return { home, path }
  }

  it('resolveFileChain finds the chain from the moved (current) cwd', async () => {
    const { home, path } = await seed()
    const chain = await resolveFileChain({
      agentKind: 'claude-code',
      cwd: '/repo/worktrees/moved-here', // the restamped cwd — wrong bucket
      resumeValue: 'sess-moved',
      homeDir: home,
    })
    expect(chain.map((c) => c.path)).toEqual([path])
  })

  it('transcriptSourceFor reads the full window from the moved cwd', async () => {
    const { home } = await seed()
    const source = await transcriptSourceFor({
      agentKind: 'claude-code',
      cwd: '/repo/worktrees/moved-here',
      resumeValue: 'sess-moved',
      homeDir: home,
    })
    const page = await source.readSlice({ direction: 'before', limit: 50 })
    const texts = page.items.map((i) => JSON.stringify(i))
    expect(texts.join('\n')).toContain('hello from the old worktree')
    expect(texts.join('\n')).toContain('still here')
  })
})

describe('Grok transcript read when cwd and session bucket disagree', () => {
  async function seed(): Promise<{ home: string; path: string }> {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-moved-'))
    const paths = grokSessionPaths({
      cwd: '/repo',
      sessionId: '67e48205-9b61-4c2e-a6de-250f50400142',
      homeDir: home,
    })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(
      paths.chatHistoryPath,
      `${[
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-12T22:13:04.000Z',
          content: 'please have a look at unread indicators',
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-12T22:44:28.000Z',
          content: 'Unread stays off after you open an issue.',
        }),
      ].join('\n')}\n`,
    )
    return { home, path: paths.chatHistoryPath }
  }

  it('resolveFileChain finds chat_history under the git-root bucket', async () => {
    const { home, path } = await seed()
    const chain = await resolveFileChain({
      agentKind: 'grok',
      cwd: '/repo/.worktrees/issue-912-unread-indicators',
      resumeValue: '67e48205-9b61-4c2e-a6de-250f50400142',
      homeDir: home,
    })
    expect(chain.map((c) => c.path)).toEqual([path])
  })

  it('transcriptSourceFor reads the window via a summary.json pathHint', async () => {
    const { home } = await seed()
    const hint = grokSessionPaths({
      cwd: '/repo',
      sessionId: '67e48205-9b61-4c2e-a6de-250f50400142',
      homeDir: home,
    }).summaryPath
    await writeFile(hint, JSON.stringify({ info: { id: '67e48205-9b61-4c2e-a6de-250f50400142' } }))
    const source = await transcriptSourceFor({
      agentKind: 'grok',
      cwd: '/repo/.worktrees/issue-912-unread-indicators',
      resumeValue: '67e48205-9b61-4c2e-a6de-250f50400142',
      pathHint: hint,
      homeDir: home,
    })
    const page = await source.readSlice({ direction: 'before', limit: 50 })
    const texts = page.items.map((item) => item.text)
    expect(texts).toContain('please have a look at unread indicators')
    expect(texts).toContain('Unread stays off after you open an issue.')
  })
})
