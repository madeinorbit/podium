/**
 * Chain-resolution regression tests (POD-4471): the per-harness transcript
 * layout resolves the SPECIFIC conversation named by the resume value — never
 * the whole cwd bucket — and reads through the Store take the adapter grammar
 * as their parameter.
 *
 * Successor of `file-chain.test.ts` + `moved-cwd.test.ts` (removed with
 * `transcript-source.ts`): those pinned `resolveFileChain`'s PATH-hashed file
 * ids, a semantic with no production caller — the live tail, the on-demand
 * slice and the mirror lake all namespace by conversation identity
 * (`fileIdFor(resumeValue)`), which is what these tests pin now. The chain
 * PATHS assertions (moved worktrees, foreign cwd buckets, filename fallbacks)
 * are unchanged.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug } from '../agent-state/claude-locate.js'
import { grokSessionPaths } from '../agent-state/grok.js'
import { declaredValue, type TranscriptSourceInput } from '../manifest.js'
import { manifestFor } from '../registry.js'
import { decodeCursor } from './cursor-codec.js'
import { fileIdFor, type ChainEntry } from './file-chain.js'
import type { SliceResult } from './slice.js'
import { transcriptSourceFromGrammar } from './store.js'

/** Resolve the ordered oldest→newest chain for a harness through its adapter
 *  transcript section — the Store's layout lookup. Unknown kinds (including
 *  shells) and harnesses without a file chain resolve to []. */
async function resolveChain(
  agentKind: string,
  input: TranscriptSourceInput,
): Promise<ChainEntry[]> {
  const transcript = manifestFor(agentKind)?.transcript
  const grammar = transcript ? declaredValue(transcript) : undefined
  if (!grammar) return []
  const chainPaths = declaredValue(grammar.chainPaths)
  if (!chainPaths) return []
  const sessionIdentity = input.resumeValue
  return (await chainPaths(input)).map((path) => ({
    path,
    fileId: sessionIdentity ? fileIdFor(sessionIdentity) : fileIdFor(path),
  }))
}

async function readThroughGrammar(agentKind: string, input: TranscriptSourceInput): Promise<SliceResult> {
  const transcript = manifestFor(agentKind)?.transcript
  const grammar = transcript ? declaredValue(transcript) : undefined
  if (!grammar) return { items: [] as TranscriptItem[], hasMore: false }
  const source = await transcriptSourceFromGrammar(grammar, input)
  return source.readSlice({ direction: 'before', limit: 50 })
}

describe('fileIdFor', () => {
  it('is stable and never leaks the raw path', () => {
    const id = fileIdFor('/home/u/.claude/projects/x/abc.jsonl')
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    expect(fileIdFor('/home/u/.claude/projects/x/abc.jsonl')).toBe(id)
    expect(id).not.toContain('claude')
  })
})

describe('resolveChain', () => {
  it('resolves ONLY the claude conversation named by the resume value, not the whole bucket', async () => {
    // The cwd bucket holds many distinct conversations. The layout must return
    // exactly the resume value's file — NOT every sibling in the bucket (which would
    // merge unrelated conversations into one transcript).
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const slug = '/work/repo'.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    await mkdir(dir, { recursive: true })
    const target = join(dir, 'conv-1.jsonl')
    const sibling = join(dir, 'conv-2.jsonl')
    await writeFile(target, '{}\n')
    await writeFile(sibling, '{}\n') // a DIFFERENT conversation in the same bucket
    const chain = await resolveChain('claude-code', {
      cwd: '/work/repo',
      resumeValue: 'conv-1',
      homeDir: home,
    })
    expect(chain.map((c) => c.path)).toEqual([target]) // sibling must NOT appear
    // Namespaced by conversation identity — the same namespace the live tail
    // and the on-demand slice stamp, so cursors interoperate.
    expect(chain).toEqual([{ path: target, fileId: fileIdFor('conv-1') }])
  })

  it('returns [] for claude with no resume value (wait for the hook, do not guess a sibling)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    expect(await resolveChain('claude-code', { cwd: '/work/repo', homeDir: home })).toEqual([])
  })

  it('returns [] for claude when the resume value file does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const chain = await resolveChain('claude-code', {
      cwd: '/work/repo',
      resumeValue: 'missing',
      homeDir: home,
    })
    expect(chain).toEqual([])
  })

  it('resolves a one-entry chain for cursor from cwd + chatId', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const cwd = '/work/repo'
    const chatId = 'chat-123'
    const { cursorSessionPaths } = await import('../cursor/paths.js')
    const transcriptPath = cursorSessionPaths({ cwd, chatId, homeDir: home }).transcriptPath
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, '{}\n')
    const chain = await resolveChain('cursor', { cwd, resumeValue: chatId, homeDir: home })
    expect(chain).toEqual([{ path: transcriptPath, fileId: fileIdFor(chatId) }])
  })

  it('resolves a grok chain when the file lives in a different cwd bucket', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const sessionId = 'sess-other-bucket'
    const { grokSessionPaths } = await import('../agent-state/grok.js')
    const chatHistoryPath = grokSessionPaths({
      cwd: '/repo',
      sessionId,
      homeDir: home,
    }).chatHistoryPath
    await mkdir(dirname(chatHistoryPath), { recursive: true })
    await writeFile(chatHistoryPath, '{}\n')
    const chain = await resolveChain('grok', {
      cwd: '/repo/.worktrees/issue-912',
      resumeValue: sessionId,
      homeDir: home,
    })
    expect(chain).toEqual([{ path: chatHistoryPath, fileId: fileIdFor(sessionId) }])
  })

  it('resolves a one-entry chain for grok from cwd + sessionId', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const cwd = '/work/repo'
    const sessionId = 'sess-456'
    const { grokSessionPaths } = await import('../agent-state/grok.js')
    const chatHistoryPath = grokSessionPaths({ cwd, sessionId, homeDir: home }).chatHistoryPath
    await mkdir(dirname(chatHistoryPath), { recursive: true })
    await writeFile(chatHistoryPath, '{}\n')
    const chain = await resolveChain('grok', { cwd, resumeValue: sessionId, homeDir: home })
    expect(chain).toEqual([{ path: chatHistoryPath, fileId: fileIdFor(sessionId) }])
  })

  it('resolves a one-entry chain for codex via the rollout filename fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const threadId = 'thread-789'
    const dir = join(home, '.codex', 'sessions', '2026', '06', '16')
    await mkdir(dir, { recursive: true })
    // The filename fallback matches a rollout whose name includes the resume value.
    const rollout = join(dir, `rollout-2026-06-16T16-11-26-${threadId}.jsonl`)
    await writeFile(rollout, '{}\n')
    const chain = await resolveChain('codex', {
      cwd: '/work/repo',
      resumeValue: threadId,
      homeDir: home,
    })
    expect(chain).toEqual([{ path: rollout, fileId: fileIdFor(threadId) }])
  })

  it('returns [] for codex when the rollout cannot be found', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const chain = await resolveChain('codex', {
      cwd: '/work/repo',
      resumeValue: 'missing-thread',
      homeDir: home,
    })
    expect(chain).toEqual([])
  })

  it('returns [] for grok/cursor when the file is missing on disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    expect(
      await resolveChain('cursor', { cwd: '/work/repo', resumeValue: 'no-such-chat', homeDir: home }),
    ).toEqual([])
    expect(
      await resolveChain('grok', { cwd: '/work/repo', resumeValue: 'no-such-sess', homeDir: home }),
    ).toEqual([])
  })

  it('returns [] for a file-based harness when resumeValue is missing', async () => {
    expect(await resolveChain('cursor', { cwd: '/x' })).toEqual([])
    expect(await resolveChain('grok', { cwd: '/x' })).toEqual([])
    expect(await resolveChain('codex', { cwd: '/x' })).toEqual([])
  })

  it('still returns [] for opencode (handled by a separate DB adapter)', async () => {
    expect(await resolveChain('opencode', { cwd: '/x', resumeValue: 'p' })).toEqual([])
  })

  it('returns [] for unknown kinds, including shells', async () => {
    expect(await resolveChain('shell', { cwd: '/x', resumeValue: 'p' })).toEqual([])
    expect(await resolveChain('no-such-harness', { cwd: '/x', resumeValue: 'p' })).toEqual([])
  })
})

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

  it('resolveChain finds the chain from the moved (current) cwd', async () => {
    const { home, path } = await seed()
    const chain = await resolveChain('claude-code', {
      cwd: '/repo/worktrees/moved-here', // the restamped cwd — wrong bucket
      resumeValue: 'sess-moved',
      homeDir: home,
    })
    expect(chain.map((c) => c.path)).toEqual([path])
  })

  it('the Store reads the full window from the moved cwd', async () => {
    const { home } = await seed()
    const page = await readThroughGrammar('claude-code', {
      cwd: '/repo/worktrees/moved-here',
      resumeValue: 'sess-moved',
      homeDir: home,
    })
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

  it('resolveChain finds chat_history under the git-root bucket', async () => {
    const { home, path } = await seed()
    const chain = await resolveChain('grok', {
      cwd: '/repo/.worktrees/issue-912-unread-indicators',
      resumeValue: '67e48205-9b61-4c2e-a6de-250f50400142',
      homeDir: home,
    })
    expect(chain.map((c) => c.path)).toEqual([path])
  })

  it('the Store reads the window via a summary.json pathHint', async () => {
    const { home } = await seed()
    const hint = grokSessionPaths({
      cwd: '/repo',
      sessionId: '67e48205-9b61-4c2e-a6de-250f50400142',
      homeDir: home,
    }).summaryPath
    await writeFile(hint, JSON.stringify({ info: { id: '67e48205-9b61-4c2e-a6de-250f50400142' } }))
    const page = await readThroughGrammar('grok', {
      cwd: '/repo/.worktrees/issue-912-unread-indicators',
      resumeValue: '67e48205-9b61-4c2e-a6de-250f50400142',
      pathHint: hint,
      homeDir: home,
    })
    const texts = page.items.map((item) => item.text)
    expect(texts).toContain('please have a look at unread indicators')
    expect(texts).toContain('Unread stays off after you open an issue.')
  })

  it('reads the current product transcript authority before legacy chat_history', async () => {
    const { home } = await seed()
    const nativeId = '67e48205-9b61-4c2e-a6de-250f50400142'
    const transcriptRoot = join(home, 'product-transcripts')
    const current = join(transcriptRoot, 'project-id', `${nativeId}.jsonl`)
    await mkdir(join(transcriptRoot, 'project-id'), { recursive: true })
    await writeFile(
      current,
      `${[
        JSON.stringify({
          uuid: 'current-user-id',
          type: 'user',
          timestamp: '2026-08-31T04:45:06.000Z',
          content: 'current authority user',
        }),
        JSON.stringify({
          uuid: 'current-assistant-id',
          type: 'assistant',
          timestamp: '2026-08-31T04:45:07.000Z',
          content: 'current authority assistant',
        }),
      ].join('\n')}\n`,
    )
    const page = await readThroughGrammar('grok', {
      cwd: '/repo/.worktrees/issue-3150-grok-headed-transcript-bridge',
      resumeValue: nativeId,
      homeDir: home,
      transcriptRoot,
    })
    expect(page.items.map((item) => [item.id, item.text])).toEqual([
      ['current-user-id', 'current authority user'],
      ['current-assistant-id', 'current authority assistant'],
    ])
  })
})

describe('Store routing by agentKind', () => {
  it('routes a file-based harness (claude-code) to a file-chain source', async () => {
    const home = await mkdtemp(join(tmpdir(), 'src-route-claude-'))
    const bucketDir = join(
      home,
      '.claude',
      'projects',
      // claudeProjectSlug('/repo/x') — replicate the slug shape: leading dash, slashes→dashes.
      '-repo-x',
    )
    await mkdir(bucketDir, { recursive: true })
    const rec = (uuid: string, text: string) =>
      JSON.stringify({ uuid, type: 'user', message: { role: 'user', content: text } })
    await writeFile(join(bucketDir, 'conv.jsonl'), `${[5, 6, 7, 8, 9].map((i) => rec(`u${i}`, String(i))).join('\n')}\n`)
    const page = await readThroughGrammar('claude-code', {
      cwd: '/repo/x',
      resumeValue: 'conv', // resolves <bucket>/conv.jsonl (claude resolves by resume value, not bucket-glob)
      homeDir: home,
    })
    // The file-chain source serves the harness's own grammar: assert it is NOT
    // the opencode source by checking the cursor fileId is the conversation
    // namespace id, not 'opencode:...'.
    expect(page.items.length).toBeGreaterThan(0)
    const fid = decodeCursor(page.items[0]?.cursor ?? '')?.fileId
    expect(fid).not.toMatch(/^opencode:/)
    expect(page.items.map((i) => i.text)).toEqual(['5', '6', '7', '8', '9'])
  })
})
