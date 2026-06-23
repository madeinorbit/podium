import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  contentToText,
  dateField,
  isRecord,
  mapConversationRole,
  numberField,
  parseJsonLines,
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

const providerId = 'grok-sessions'

export function createGrokConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'grok',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.grok')],
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
    return { files: await listGrokSummaryFiles(sessionsRoot), diagnostics: [] }
  } catch (cause) {
    return {
      files: [],
      diagnostics: [
        {
          severity: 'error',
          providerId,
          root,
          message: 'Grok sessions directory cannot be read',
          cause,
        },
      ],
    }
  }
}

async function listGrokSummaryFiles(sessionsRoot: string): Promise<ConversationProviderFile[]> {
  const files: ConversationProviderFile[] = []
  const workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true })

  for (const workspaceDir of workspaceDirs.sort(compareDirentNames)) {
    if (!workspaceDir.isDirectory()) continue
    const workspacePath = join(sessionsRoot, workspaceDir.name)
    const sessionDirs = await readdir(workspacePath, { withFileTypes: true })

    for (const sessionDir of sessionDirs.sort(compareDirentNames)) {
      if (!sessionDir.isDirectory()) continue
      const summaryPath = join(workspacePath, sessionDir.name, 'summary.json')
      if (await pathExists(summaryPath)) files.push({ path: summaryPath })
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

  let raw: string
  try {
    raw = await readFile(file.path, 'utf8')
  } catch (cause) {
    return { diagnostics: [readDiagnostic(root, file.path, cause)] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (cause) {
    return {
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file.path,
          message: 'Could not parse Grok session summary',
          cause,
        },
      ],
    }
  }
  if (!isRecord(parsed)) return { diagnostics: [] }

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
          message: 'Grok session path cannot be resolved',
          cause,
        },
      ],
    }
  }

  return { summary: await summarizeGrokSummary(parsed, root, canonical, stats), diagnostics: [] }
}

async function summarizeGrokSummary(
  summary: Record<string, unknown>,
  root: string,
  file: string,
  stats: ConversationFileStat,
): Promise<AgentConversationSummary> {
  const info = isRecord(summary.info) ? summary.info : {}
  const id = stringField(info, 'id') ?? basename(dirname(file))
  const nativeTitle =
    compactText(stringField(summary, 'session_summary')) ??
    compactText(stringField(summary, 'generated_title'))
  const sessionDir = dirname(file)
  const relatedPaths = await existingPaths([
    join(sessionDir, 'chat_history.jsonl'),
    join(sessionDir, 'updates.jsonl'),
  ])

  return {
    id,
    agentKind: 'grok',
    title: nativeTitle ?? id,
    titleSource: nativeTitle ? 'native' : 'filename',
    projectPath: stringField(info, 'cwd') ?? decodedWorkspacePath(file),
    statusHint: 'unknown',
    createdAt: dateField(summary, 'created_at') ?? createdAtFromStats(stats),
    updatedAt:
      dateField(summary, 'updated_at') ??
      dateField(summary, 'last_active_at') ??
      validDate(stats.mtime, stats.mtimeMs),
    messageCount: numberField(summary, 'num_chat_messages') ?? numberField(summary, 'num_messages'),
    git: gitMetadata(summary),
    resume: { kind: 'grok-session', value: id },
    source: {
      providerId,
      root,
      path: file,
      ...(relatedPaths.length > 0 ? { relatedPaths } : {}),
    },
  }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  const chatPath = join(dirname(summary.source.path), 'chat_history.jsonl')
  let parsed: { records: unknown[]; diagnostics: AgentConversationDiagnostic[] }
  try {
    const text = await readFile(chatPath, 'utf8')
    parsed = parseJsonLines(text, { providerId, root: summary.source.root, path: chatPath })
  } catch (cause) {
    throw new AgentConversationLoadError(`Could not load Grok conversation from ${chatPath}`, {
      cause,
    })
  }

  // A read failure already threw above. Per-line PARSE diagnostics were isolated by
  // the JSONL reader (good records survive) — don't re-escalate them into a
  // whole-conversation throw; keep the records and surface them non-fatally.
  if (parsed.diagnostics.length > 0) {
    console.warn(
      `[podium] ${parsed.diagnostics.length} unparseable line(s) in Grok conversation ${chatPath} — skipped`,
    )
  }

  const messages = grokMessages(parsed.records)
  return {
    ...summary,
    messageCount: messages.length,
    messages,
    raw: parsed.records,
    diagnostics: parsed.diagnostics,
  }
}

function grokMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record)) continue
    const role = grokRole(record)
    if (!role) continue
    const content = contentToText(record.content) || contentToText(record.message)
    if (!content) continue
    messages.push({
      role,
      content,
      createdAt: dateField(record, 'timestamp') ?? dateField(record, 'created_at'),
      raw: record,
    })
  }

  return messages
}

function grokRole(record: Record<string, unknown>): AgentConversationMessage['role'] | undefined {
  const explicit = stringField(record, 'role')
  if (explicit) return mapConversationRole(explicit)

  switch (stringField(record, 'type')) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'tool':
    case 'tool_result':
      return 'tool'
    default:
      return undefined
  }
}

function gitMetadata(summary: Record<string, unknown>): AgentConversationSummary['git'] {
  const branch = stringField(summary, 'head_branch')
  const sha = stringField(summary, 'head_commit')
  const remotes = summary.git_remotes
  const originUrl = Array.isArray(remotes)
    ? remotes.find((v): v is string => typeof v === 'string')
    : undefined
  return branch || sha || originUrl
    ? {
        ...(branch ? { branch } : {}),
        ...(sha ? { sha } : {}),
        ...(originUrl ? { originUrl } : {}),
      }
    : undefined
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = []
  for (const path of paths) {
    if (await pathExists(path)) existing.push(path)
  }
  return existing
}

function decodedWorkspacePath(file: string): string | undefined {
  const encoded = basename(dirname(dirname(file)))
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

function readDiagnostic(root: string, path: string, cause: unknown): AgentConversationDiagnostic {
  return {
    severity: 'warning',
    providerId,
    root,
    path,
    message: 'Grok session summary cannot be read',
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

function compactText(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim()
  return compact ? compact : undefined
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

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}
