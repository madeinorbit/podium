import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { piCwdFromSlug, piSessionIdFromPath } from '../../pi/paths.js'
import {
  compactText,
  contentToText,
  dateField,
  dateFromEpochMillis,
  isRecord,
  parseJsonLines,
  readJsonLinesHead,
  stringField,
} from '../jsonl.js'
import { canonicalPath, pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationFileStat,
  ConversationProvider,
  ConversationProviderFile,
  ProviderRootListing,
  ProviderScanResult,
  ProviderSummaryContext,
  ProviderSummaryResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'

const log = createLogger('harness:discovery')
const providerId = 'pi-sessions'

/**
 * Pi sessions: one JSONL per session under `<agent dir>/sessions/--<cwd>--/`.
 * The root handed in is the AGENT dir (`~/.pi/agent` by default), so the
 * transcript-mirror allowlist covers every file Pi writes there.
 */
export function createPiConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'pi',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.pi', 'agent')],
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
  const canonical = memoizeCanonicalPath()

  await Promise.all(
    listing.files.map(async (file) => {
      const result = await summarizeFile(root, file, { canonicalPath: canonical })
      diagnostics.push(...result.diagnostics)
      if (result.summary) conversations.push(result.summary)
    }),
  )

  return { conversations, diagnostics }
}

async function listRoot(root: string): Promise<ProviderRootListing> {
  const sessionsRoot = join(root, 'sessions')
  if (!(await pathExists(sessionsRoot))) return { files: [], diagnostics: [] }

  try {
    return { files: await listPiSessionFiles(sessionsRoot), diagnostics: [] }
  } catch (cause) {
    return {
      files: [],
      diagnostics: [
        {
          severity: 'error',
          providerId,
          root,
          message: 'Pi sessions directory cannot be read',
          cause,
        },
      ],
    }
  }
}

async function listPiSessionFiles(sessionsRoot: string): Promise<ConversationProviderFile[]> {
  const files: ConversationProviderFile[] = []
  const buckets = await readdir(sessionsRoot, { withFileTypes: true })
  for (const bucket of buckets.sort(compareDirentNames)) {
    if (!bucket.isDirectory()) continue
    const bucketPath = join(sessionsRoot, bucket.name)
    const entries = await readdir(bucketPath, { withFileTypes: true })
    for (const entry of entries.sort(compareDirentNames)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      files.push({ path: join(bucketPath, entry.name) })
    }
  }
  return files
}

async function summarizeFile(
  root: string,
  file: ConversationProviderFile,
  context: ProviderSummaryContext = {},
): Promise<ProviderSummaryResult> {
  let stats: ConversationFileStat
  try {
    stats = context.stats ?? (await stat(file.path))
  } catch (cause) {
    return { diagnostics: [readDiagnostic(root, file.path, cause)] }
  }

  const parsed = await readJsonLinesHead(
    file.path,
    { providerId, root, path: file.path },
    { maxLines: 40, maxBytes: 64 * 1024 },
  )
  // A torn line in the head is a diagnostic beside the summary, not a lost
  // session — the header and the good records still describe it.
  if (parsed.records.length === 0) return { diagnostics: parsed.diagnostics }

  let canonical: string
  try {
    canonical = await (context.canonicalPath ?? canonicalPath)(file.path)
  } catch (cause) {
    return {
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file.path,
          message: 'Pi session path cannot be resolved',
          cause,
        },
      ],
    }
  }

  return {
    summary: summarizePiHeadRecords(parsed.records, root, file, canonical, stats),
    diagnostics: parsed.diagnostics,
  }
}

function summarizePiHeadRecords(
  records: unknown[],
  root: string,
  file: ConversationProviderFile,
  canonical: string,
  stats: ConversationFileStat,
): AgentConversationSummary {
  const header = records.find(
    (record): record is Record<string, unknown> =>
      isRecord(record) && stringField(record, 'type') === 'session',
  )
  const id =
    (header && stringField(header, 'id')) ??
    piSessionIdFromPath(file.path) ??
    basename(file.path, '.jsonl')
  const nativeTitle = sessionName(records)
  const promptTitle = firstUserPrompt(records)
  const title = nativeTitle ?? promptTitle ?? id
  const messageCount = records.filter(
    (record) => isRecord(record) && stringField(record, 'type') === 'message',
  ).length
  const projectPath =
    (header && stringField(header, 'cwd')) ?? piCwdFromSlug(basename(dirname(file.path)))
  const parentSession = header ? stringField(header, 'parentSession') : undefined

  return {
    id,
    agentKind: 'pi',
    title,
    titleSource: nativeTitle ? 'native' : promptTitle ? 'heuristic' : 'filename',
    ...(projectPath ? { projectPath } : {}),
    ...(parentSession
      ? { parentConversationId: piSessionIdFromPath(parentSession) ?? parentSession }
      : {}),
    statusHint: 'unknown',
    createdAt: (header && dateField(header, 'timestamp')) ?? createdAtFromStats(stats),
    updatedAt: validDate(stats.mtime, stats.mtimeMs),
    messageCount,
    sizeBytes: stats.size,
    resume: { kind: 'pi-session', value: id },
    source: {
      providerId,
      root,
      path: canonical,
      relatedPaths: [file.path],
    },
  }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  let parsed: { records: unknown[]; diagnostics: AgentConversationDiagnostic[] }
  try {
    const text = await readFile(summary.source.path, 'utf8')
    parsed = parseJsonLines(text, {
      providerId,
      root: summary.source.root,
      path: summary.source.path,
    })
  } catch (cause) {
    throw new AgentConversationLoadError(
      `Could not load Pi conversation from ${summary.source.path}`,
      { cause },
    )
  }

  if (parsed.diagnostics.length > 0) {
    log.warn('unparseable line(s) in conversation — skipped', {
      agent: 'pi',
      lines: parsed.diagnostics.length,
      path: summary.source.path,
    })
  }

  const messages = piMessages(parsed.records)
  return {
    ...summary,
    messageCount: messages.length,
    messages,
    raw: parsed.records,
    diagnostics: parsed.diagnostics,
  }
}

function piMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []
  for (const record of records) {
    if (!isRecord(record) || stringField(record, 'type') !== 'message') continue
    const message = isRecord(record.message) ? record.message : undefined
    if (!message) continue
    const role = conversationRole(stringField(message, 'role'))
    if (!role) continue
    const content =
      role === 'tool' && stringField(message, 'role') === 'bashExecution'
        ? `$ ${stringField(message, 'command') ?? ''}\n${typeof message.output === 'string' ? message.output : ''}`.trim()
        : contentToText(message.content)
    if (!content) continue
    messages.push({
      role,
      content,
      createdAt: dateField(record, 'timestamp') ?? dateFromEpochMillis(message.timestamp),
      raw: record,
    })
  }
  return messages
}

function conversationRole(role: string | undefined): AgentConversationMessage['role'] | undefined {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'toolResult':
    case 'bashExecution':
      return 'tool'
    case 'compactionSummary':
    case 'branchSummary':
      return 'system'
    default:
      return undefined
  }
}

function sessionName(records: unknown[]): string | undefined {
  let name: string | undefined
  for (const record of records) {
    if (!isRecord(record) || stringField(record, 'type') !== 'session_info') continue
    name = compactText(stringField(record, 'name')) ?? name
  }
  return name
}

function firstUserPrompt(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record) || stringField(record, 'type') !== 'message') continue
    const message = isRecord(record.message) ? record.message : undefined
    if (!message || stringField(message, 'role') !== 'user') continue
    const text = compactText(contentToText(message.content))
    if (!text) continue
    return text.length > 100 ? `${text.slice(0, 97)}...` : text
  }
  return undefined
}

function readDiagnostic(root: string, path: string, cause: unknown): AgentConversationDiagnostic {
  return {
    severity: 'warning',
    providerId,
    root,
    path,
    message: 'Pi session file cannot be read',
    cause,
  }
}

function createdAtFromStats(stats: ConversationFileStat): Date | undefined {
  return (
    validDate(stats.birthtime, stats.birthtimeMs) ??
    validDate(stats.ctime, stats.ctimeMs) ??
    validDate(stats.mtime, stats.mtimeMs)
  )
}

function validDate(date: Date, ms: number): Date | undefined {
  return Number.isFinite(ms) && ms > 0 && !Number.isNaN(date.getTime()) ? date : undefined
}

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name)
}

function memoizeCanonicalPath(): (path: string) => Promise<string> {
  const paths = new Map<string, Promise<string>>()
  return (path: string) => {
    let cached = paths.get(path)
    if (!cached) {
      cached = canonicalPath(path)
      paths.set(path, cached)
    }
    return cached
  }
}
