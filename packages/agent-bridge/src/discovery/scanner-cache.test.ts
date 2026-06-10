import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConversationDiscoveryCache } from './cache.js'
import { scanAgentConversationsCached } from './scanner.js'
import type {
  AgentConversation,
  AgentConversationSummary,
  ConversationProvider,
  ProviderRootListing,
  ProviderSummaryContext,
  ProviderSummaryResult,
} from './types.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-cached-scan-'))
}

async function writeCandidate(root: string, name: string, mtime: string): Promise<string> {
  const file = join(root, name)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '{"ok":true}\n')
  await utimes(file, new Date(mtime), new Date(mtime))
  return file
}

function fakeSummary(path: string, id: string): AgentConversationSummary {
  return {
    id,
    agentKind: 'codex',
    title: id,
    titleSource: 'filename',
    projectPath: '/repo/app',
    updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    resume: { kind: 'codex-thread', value: id },
    source: { providerId: 'fake-codex', root: '/fake-root', path },
  }
}

function providerFor(files: string[], calls: { summarize: number }): ConversationProvider {
  return {
    id: 'fake-codex',
    agentKind: 'codex',
    defaultRoots: () => [],
    async listRoot(root: string): Promise<ProviderRootListing> {
      return { files: files.map((path) => ({ path })), diagnostics: [], state: { root } }
    },
    async summarizeFile(
      root: string,
      file: { path: string },
      _context: ProviderSummaryContext,
    ): Promise<ProviderSummaryResult> {
      calls.summarize++
      return { summary: { ...fakeSummary(file.path, file.path.split('/').pop() ?? file.path), source: { ...fakeSummary(file.path, file.path).source, root } }, diagnostics: [] }
    },
    async scanRoot(): Promise<{ conversations: AgentConversationSummary[]; diagnostics: [] }> {
      throw new Error('scanRoot should not be used by cached scanner')
    },
    async loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
      return { ...summary, messages: [] }
    },
  }
}

describe('scanAgentConversationsCached', () => {
  test('reuses cached summaries for unchanged files without re-summarizing', async () => {
    const root = await createRoot()
    const file = await writeCandidate(root, 'one.jsonl', '2026-06-01T10:00:00.000Z')
    const cache = new ConversationDiscoveryCache(':memory:')
    const calls = { summarize: 0 }
    const provider = providerFor([file], calls)

    const first = await scanAgentConversationsCached({
      cache,
      providers: [provider],
      includeDefaults: false,
      extraRoots: { codex: [root] },
    })
    const second = await scanAgentConversationsCached({
      cache,
      providers: [provider],
      includeDefaults: false,
      extraRoots: { codex: [root] },
    })

    expect(first.conversations).toHaveLength(1)
    expect(second.conversations).toHaveLength(1)
    expect(calls.summarize).toBe(1)
    cache.close()
  })

  test('re-summarizes changed files and deletes missing cache rows', async () => {
    const root = await createRoot()
    const file = await writeCandidate(root, 'one.jsonl', '2026-06-01T10:00:00.000Z')
    const cache = new ConversationDiscoveryCache(':memory:')
    const calls = { summarize: 0 }
    const provider = providerFor([file], calls)

    await scanAgentConversationsCached({
      cache,
      providers: [provider],
      includeDefaults: false,
      extraRoots: { codex: [root] },
    })
    await writeFile(file, '{"changed":true}\n')
    await utimes(file, new Date('2026-06-01T10:05:00.000Z'), new Date('2026-06-01T10:05:00.000Z'))
    await scanAgentConversationsCached({
      cache,
      providers: [provider],
      includeDefaults: false,
      extraRoots: { codex: [root] },
    })

    expect(calls.summarize).toBe(2)

    await rm(file)
    const empty = await scanAgentConversationsCached({
      cache,
      providers: [providerFor([], calls)],
      includeDefaults: false,
      extraRoots: { codex: [root] },
    })
    expect(empty.conversations).toEqual([])
    expect(cache.listSummaries()).toEqual([])
    expect(cache.getFresh(file, await stat(root), 'codex')).toBeUndefined()
    cache.close()
  })
})
