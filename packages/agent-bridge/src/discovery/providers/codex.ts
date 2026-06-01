import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  contentToText,
  dateField,
  isRecord,
  mapConversationRole,
  parseJsonLines,
  stringField,
} from '../jsonl.js'
import { canonicalPath, listFilesRecursive, pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationProvider,
  ProviderScanResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'
import { type CodexThreadMetadata, readCodexStateMetadata } from './codex-state.js'

export function createCodexConversationProvider(): ConversationProvider {
  return {
    id: 'codex-jsonl',
    agentKind: 'codex',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.codex')],
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const sessionsRoot = join(root, 'sessions')
  const state = await readCodexStateMetadata(root)
  if (!(await pathExists(sessionsRoot))) {
    return { conversations: [], diagnostics: state.diagnostics }
  }

  let files: string[]
  try {
    files = await listFilesRecursive(sessionsRoot, (file) => file.endsWith('.jsonl'))
  } catch (cause) {
    return {
      conversations: [],
      diagnostics: [
        ...state.diagnostics,
        {
          severity: 'error',
          providerId: 'codex-jsonl',
          root,
          message: 'Codex sessions directory cannot be read',
          cause,
        },
      ],
    }
  }

  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = [...state.diagnostics]

  for (const file of files) {
    const parsed = await readCodexRecords(file, root)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.diagnostics.length > 0) continue

    const canonical = await canonicalPath(file)
    const metadata = state.byRolloutPath.get(canonical) ?? state.byRolloutPath.get(file)
    const summary = await summarizeCodexRecords(parsed.records, root, canonical, metadata)
    if (summary) conversations.push(summary)
  }

  return { conversations, diagnostics }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  let parsed: { records: unknown[]; diagnostics: AgentConversationDiagnostic[] }
  try {
    parsed = await readCodexRecords(summary.source.path, summary.source.root)
  } catch (cause) {
    throw new AgentConversationLoadError(
      `Could not load Codex conversation from ${summary.source.path}`,
      { cause },
    )
  }

  if (parsed.diagnostics.length > 0) {
    const readDiagnostic = parsed.diagnostics.find(
      (diagnostic) => diagnostic.message === 'Codex session file cannot be read',
    )
    if (readDiagnostic) {
      throw new AgentConversationLoadError(
        `Could not load Codex conversation from ${summary.source.path}`,
        { cause: readDiagnostic.cause },
      )
    }

    throw new AgentConversationLoadError(
      `Could not parse Codex conversation ${summary.source.path}`,
    )
  }

  return { ...summary, messages: codexMessages(parsed.records), raw: parsed.records }
}

async function readCodexRecords(
  file: string,
  root: string,
): Promise<{
  records: unknown[]
  diagnostics: AgentConversationDiagnostic[]
}> {
  try {
    const text = await readFile(file, 'utf8')
    return parseJsonLines(text, { providerId: 'codex-jsonl', root, path: file })
  } catch (cause) {
    return {
      records: [],
      diagnostics: [
        {
          severity: 'warning',
          providerId: 'codex-jsonl',
          root,
          path: file,
          message: 'Codex session file cannot be read',
          cause,
        },
      ],
    }
  }
}

async function summarizeCodexRecords(
  records: unknown[],
  root: string,
  file: string,
  metadata: CodexThreadMetadata | undefined,
): Promise<AgentConversationSummary | undefined> {
  const meta = records.map(codexPayload).find((payload) => stringField(payload, 'id'))
  const messages = codexMessages(records)
  if (!meta && !metadata && messages.length === 0) return undefined

  const id =
    metadata?.id ?? (meta ? stringField(meta, 'id') : undefined) ?? basename(file, '.jsonl')
  const dates = records.map(recordTimestamp).filter((date): date is Date => date !== undefined)

  return {
    id,
    agentKind: 'codex',
    title: metadata?.title ?? fallbackTitle(file),
    titleSource: metadata?.title ? 'native' : 'filename',
    projectPath: metadata?.cwd ?? (meta ? stringField(meta, 'cwd') : undefined),
    parentConversationId: metadata?.parentThreadId,
    statusHint: metadata?.archived ? 'archived' : 'unknown',
    createdAt: metadata?.createdAt ?? dates[0],
    updatedAt: metadata?.updatedAt ?? dates.at(-1),
    messageCount: messages.length,
    git: metadata?.git,
    resume: { kind: 'codex-thread', value: id },
    source: {
      providerId: 'codex-jsonl',
      root,
      path: file,
      relatedPaths:
        metadata?.rolloutPath && metadata.rolloutPath !== file ? [metadata.rolloutPath] : undefined,
    },
  }
}

function codexMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record)) continue
    const payload = codexPayload(record)
    if (payload.type !== 'message') continue

    messages.push({
      role: mapConversationRole(payload.role),
      content: contentToText(payload.content),
      createdAt: recordTimestamp(record),
      raw: record,
    })
  }

  return messages
}

function codexPayload(record: unknown): Record<string, unknown> {
  if (!isRecord(record)) return {}
  return isRecord(record.payload) ? record.payload : {}
}

function recordTimestamp(record: unknown): Date | undefined {
  if (!isRecord(record)) return undefined
  const timestamp = dateField(record, 'timestamp')
  if (timestamp) return timestamp
  return dateField(codexPayload(record), 'timestamp')
}

function fallbackTitle(file: string): string {
  return basename(file, '.jsonl')
}
