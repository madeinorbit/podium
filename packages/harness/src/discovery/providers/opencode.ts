import { homedir } from 'node:os'
import { join } from 'node:path'
import { opencodePartToItems } from '@podium/transcript'
import { isOpencodeCliAvailable } from '../../opencode/cli.js'
import {
  listOpencodeSessions,
  loadOpencodeMessageParts,
  opencodeDataRoot,
  openOpencodeDb,
  openOpencodeDbAt,
} from '../../opencode/db.js'
import { pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationProvider,
  ConversationProviderFile,
  ProviderRootListing,
  ProviderScanResult,
  ProviderSummaryContext,
  ProviderSummaryResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'

const providerId = 'opencode-sessions'

export function createOpencodeConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'opencode',
    defaultRoots: ({ homeDir }) => [opencodeDataRoot(homeDir)],
    listRoot,
    summarizeFile,
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const listing = await listRoot(root)
  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = [...listing.diagnostics]

  for (const file of listing.files) {
    const result = await summarizeFile(root, file)
    diagnostics.push(...result.diagnostics)
    if (result.summary) conversations.push(result.summary)
  }

  return { conversations, diagnostics }
}

async function listRoot(root: string): Promise<ProviderRootListing> {
  const diagnostics: AgentConversationDiagnostic[] = []
  if (!isOpencodeCliAvailable()) {
    diagnostics.push({
      severity: 'warning',
      providerId,
      root,
      message: 'opencode CLI is not installed or not on PATH',
    })
    return { files: [], diagnostics }
  }

  const dbPath = join(root, 'opencode.db')
  if (!(await pathExists(dbPath))) {
    return { files: [], diagnostics }
  }

  const db = openOpencodeDbAt(root)
  if (!db) {
    diagnostics.push({
      severity: 'warning',
      providerId,
      root,
      path: dbPath,
      message: 'opencode database cannot be opened',
    })
    return { files: [], diagnostics }
  }

  try {
    const sessions = listOpencodeSessions(db)
    return {
      files: sessions.map((session) => ({ path: join(root, `${session.id}.session`) })),
      diagnostics,
    }
  } catch (cause) {
    diagnostics.push({
      severity: 'error',
      providerId,
      root,
      path: dbPath,
      message: 'Could not list opencode sessions',
      cause,
    })
    return { files: [], diagnostics }
  } finally {
    db.close()
  }
}

async function summarizeFile(
  root: string,
  file: ConversationProviderFile,
  _context: ProviderSummaryContext = {},
): Promise<ProviderSummaryResult> {
  const sessionId = file.path
    .split('/')
    .pop()
    ?.replace(/\.session$/, '')
  if (!sessionId) return { diagnostics: [] }

  const db = openOpencodeDbAt(root)
  if (!db) {
    return {
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file.path,
          message: 'opencode database cannot be opened',
        },
      ],
    }
  }

  try {
    const sessions = listOpencodeSessions(db).filter((s) => s.id === sessionId)
    const session = sessions[0]
    if (!session) return { diagnostics: [] }
    return {
      summary: {
        id: session.id,
        agentKind: 'opencode',
        title: session.title || session.id,
        titleSource: session.title ? 'native' : 'filename',
        projectPath: session.directory,
        statusHint: 'unknown',
        createdAt: new Date(session.timeCreated),
        updatedAt: new Date(session.timeUpdated),
        messageCount: session.messageCount,
        resume: { kind: 'opencode-session', value: session.id },
        source: {
          providerId,
          root,
          path: file.path,
          relatedPaths: [join(root, 'opencode.db')],
        },
      },
      diagnostics: [],
    }
  } catch (cause) {
    return {
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file.path,
          message: 'Could not summarize opencode session',
          cause,
        },
      ],
    }
  } finally {
    db.close()
  }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  const db = openOpencodeDb()
  if (!db) {
    throw new AgentConversationLoadError('opencode database cannot be opened')
  }

  try {
    const rows = loadOpencodeMessageParts(db, summary.id, 0)
    const messages: AgentConversationMessage[] = []
    for (const row of rows) {
      for (const item of opencodePartToItems(row)) {
        if (item.role === 'tool' && item.toolResult) continue
        messages.push({
          role: item.role === 'tool' ? 'tool' : item.role,
          content: item.text,
          ...(item.ts ? { createdAt: new Date(item.ts) } : {}),
        })
      }
    }
    return { ...summary, messageCount: messages.length, messages }
  } catch (cause) {
    throw new AgentConversationLoadError(`Could not load opencode conversation ${summary.id}`, {
      cause,
    })
  } finally {
    db.close()
  }
}

export function opencodeDefaultRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.local', 'share', 'opencode')
}
