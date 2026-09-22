import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HarnessAgent } from '@podium/model'
import type {
  AgentConversation,
  AgentConversationMessage,
  ConversationProvider,
  ConversationProviderFile,
  ProviderRootListing,
  ProviderScanResult,
  ProviderSummaryResult,
} from '../../discovery/types.js'
import { AgentConversationLoadError } from '../../discovery/types.js'
import { fixtureRecordToItems } from './transcript.js'

const providerId = 'fixture-sessions'

/**
 * Fixture discovery (POD-4474) — lists the same `<home>/.fixture/sessions/`
 * JSONL files the transcript section chains, so discovery and transcript
 * reads can never disagree about where a fixture conversation lives.
 */
export function createFixtureConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'fixture' as HarnessAgent,
    defaultRoots: ({ homeDir }) => [join(homeDir, '.fixture')],
    listRoot,
    summarizeFile,
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const listing = await listRoot(root)
  const conversations: ProviderScanResult['conversations'] = []
  const diagnostics: ProviderScanResult['diagnostics'] = [...listing.diagnostics]
  for (const file of listing.files) {
    const result = await summarizeFile(root, file)
    diagnostics.push(...result.diagnostics)
    if (result.summary) conversations.push(result.summary)
  }
  return { conversations, diagnostics }
}

async function listRoot(root: string): Promise<ProviderRootListing> {
  const sessionsRoot = join(root, 'sessions')
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot)
  } catch {
    return { files: [], diagnostics: [] }
  }
  return {
    files: entries
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => ({ path: join(sessionsRoot, name) })),
    diagnostics: [],
  }
}

async function summarizeFile(
  root: string,
  file: ConversationProviderFile,
): Promise<ProviderSummaryResult> {
  const id = basename(file.path, '.jsonl')
  let sizeBytes = 0
  try {
    sizeBytes = (await stat(file.path)).size
  } catch {
    return { diagnostics: [] }
  }
  return {
    summary: {
      id,
      agentKind: 'fixture' as HarnessAgent,
      title: id,
      resume: { kind: 'fixture-session', value: id },
      sizeBytes,
      source: { providerId, root, path: file.path },
    },
    diagnostics: [],
  }
}

async function loadConversation(
  summary: Parameters<ConversationProvider['loadConversation']>[0],
): Promise<AgentConversation> {
  let bytes: string
  try {
    bytes = await readFile(summary.source.path, 'utf8')
  } catch (cause) {
    throw new AgentConversationLoadError(`fixture conversation cannot be read`, { cause })
  }
  const messages: AgentConversationMessage[] = []
  for (const line of bytes.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    for (const item of fixtureRecordToItems(record)) {
      if (item.role !== 'user' && item.role !== 'assistant') continue
      messages.push({
        role: item.role,
        content: item.text,
        ...(item.ts ? { createdAt: new Date(item.ts) } : {}),
      })
    }
  }
  return { ...summary, messages }
}
