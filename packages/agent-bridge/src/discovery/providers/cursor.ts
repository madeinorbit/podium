import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { cursorProjectPathFromSlug, cursorRoot } from '../../cursor/paths.js'
import {
  contentToText,
  isRecord,
  mapConversationRole,
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

const providerId = 'cursor-agent-transcripts'

export function createCursorConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'cursor',
    defaultRoots: ({ homeDir }) => [cursorRoot(homeDir)],
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
  const projectsRoot = join(root, 'projects')
  if (!(await pathExists(projectsRoot))) return { files: [], diagnostics: [] }

  try {
    return { files: await listCursorTranscriptFiles(projectsRoot), diagnostics: [] }
  } catch (cause) {
    return {
      files: [],
      diagnostics: [
        {
          severity: 'error',
          providerId,
          root,
          message: 'Cursor projects directory cannot be read',
          cause,
        },
      ],
    }
  }
}

async function listCursorTranscriptFiles(
  projectsRoot: string,
): Promise<ConversationProviderFile[]> {
  const files: ConversationProviderFile[] = []
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true })

  for (const projectDir of projectDirs.sort(compareDirentNames)) {
    if (!projectDir.isDirectory()) continue
    const transcriptsRoot = join(projectsRoot, projectDir.name, 'agent-transcripts')
    if (!(await pathExists(transcriptsRoot))) continue

    const chatDirs = await readdir(transcriptsRoot, { withFileTypes: true })
    for (const chatDir of chatDirs.sort(compareDirentNames)) {
      if (!chatDir.isDirectory()) continue
      const transcriptPath = join(transcriptsRoot, chatDir.name, `${chatDir.name}.jsonl`)
      if (await pathExists(transcriptPath)) files.push({ path: transcriptPath })
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
    { maxLines: 24, maxBytes: 32 * 1024 },
  )
  if (parsed.diagnostics.length > 0) return { diagnostics: parsed.diagnostics }
  if (parsed.records.length === 0 && stats.size === 0) return { diagnostics: [] }

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
          message: 'Cursor transcript path cannot be resolved',
          cause,
        },
      ],
    }
  }

  return {
    summary: summarizeCursorHeadRecords(parsed.records, root, file, canonical, stats),
    diagnostics: [],
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
    throw new AgentConversationLoadError(`Could not load Cursor conversation from ${summary.source.path}`, {
      cause,
    })
  }

  // A read failure already threw above. Per-line PARSE diagnostics were isolated by
  // the JSONL reader (good records survive) — don't re-escalate them into a
  // whole-conversation throw; keep the records and surface them non-fatally.
  if (parsed.diagnostics.length > 0) {
    console.warn(
      `[podium] ${parsed.diagnostics.length} unparseable line(s) in Cursor conversation ${summary.source.path} — skipped`,
    )
  }

  const messages = cursorMessages(parsed.records)
  return {
    ...summary,
    messageCount: messages.length,
    messages,
    raw: parsed.records,
    diagnostics: parsed.diagnostics,
  }
}

function summarizeCursorHeadRecords(
  records: unknown[],
  root: string,
  file: ConversationProviderFile,
  canonical: string,
  stats: ConversationFileStat,
): AgentConversationSummary {
  const id = basename(file.path, '.jsonl')
  const projectSlug = basename(dirname(dirname(dirname(file.path))))
  const promptTitle = firstUserPrompt(records)
  const messageCount = records.filter(
    (record) => isRecord(record) && stringField(record, 'role'),
  ).length

  return {
    id,
    agentKind: 'cursor',
    title: promptTitle ?? id,
    titleSource: promptTitle ? 'heuristic' : 'filename',
    projectPath: cursorProjectPathFromSlug(projectSlug),
    statusHint: 'unknown',
    createdAt: createdAtFromStats(stats),
    updatedAt: validDate(stats.mtime, stats.mtimeMs),
    messageCount,
    resume: { kind: 'cursor-chat', value: id },
    source: {
      providerId,
      root,
      path: canonical,
      relatedPaths: [file.path],
    },
  }
}

function cursorMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record)) continue
    const role = stringField(record, 'role')
    if (!role) continue
    const mapped = mapConversationRole(role)
    if (mapped === 'unknown') continue
    const message = recordField(record, 'message')
    const content = contentToText(message?.content)
    if (!content) continue
    messages.push({
      role: mapped,
      content: userVisibleText(content, mapped),
      raw: record,
    })
  }

  return messages
}

function firstUserPrompt(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record) || stringField(record, 'role') !== 'user') continue
    const message = recordField(record, 'message')
    const text = contentToText(message?.content).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const visible = userVisibleText(text, 'user')
    if (!visible || visible.startsWith('<')) continue
    return visible.length > 100 ? `${visible.slice(0, 97)}...` : visible
  }
  return undefined
}

function userVisibleText(text: string, role: AgentConversationMessage['role']): string {
  if (role !== 'user') return text
  const match = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text)
  if (match?.[1]) return match[1].trim()
  if (/<(user_info|rules|agent_skills|mcp_file_system|system_reminder)(>|\s)/i.test(text)) {
    return ''
  }
  return text
}

function readDiagnostic(root: string, path: string, cause: unknown): AgentConversationDiagnostic {
  return {
    severity: 'warning',
    providerId,
    root,
    path,
    message: 'Cursor transcript cannot be read',
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

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}