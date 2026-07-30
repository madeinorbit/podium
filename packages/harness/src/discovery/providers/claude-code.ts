import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  contentToText,
  dateField,
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

const providerId = 'claude-code-jsonl'

export function createClaudeCodeConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'claude-code',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.claude')],
    listRoot,
    listPathsWithinRoot,
    summarizeFile,
    scanRoot,
    loadConversation,
  }
}

/**
 * Targeted listing (POD-196): a Claude listing entry is a pure function of the
 * path shape — `projects/<project>/<name>.jsonl` for top-level conversations,
 * `projects/<project>/<convId>/subagents/<name>.jsonl` for subagent transcripts
 * (`parentConversationId` = the directory name, exactly as the full walk in
 * `listClaudeConversationFiles` derives it). This keeps the every-append active
 * refresh from readdir-walking the whole projects tree per flush.
 */
function listPathsWithinRoot(root: string, paths: readonly string[]): ProviderRootListing {
  const projectsRoot = join(root, 'projects')
  const files: ConversationProviderFile[] = []
  for (const path of paths) {
    const rel = relative(projectsRoot, path)
    if (rel.startsWith('..') || !rel.endsWith('.jsonl')) continue
    const parts = rel.split(sep)
    if (parts.length === 2) {
      files.push({ path })
    } else if (parts.length === 4 && parts[2] === 'subagents') {
      files.push({ path, parentConversationId: parts[1] })
    }
  }
  return { files, diagnostics: [] }
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
    return { files: await listClaudeConversationFiles(projectsRoot), diagnostics: [] }
  } catch (cause) {
    return {
      files: [],
      diagnostics: [
        {
          severity: 'error',
          providerId,
          root,
          message: 'Claude Code projects directory cannot be read',
          cause,
        },
      ],
    }
  }
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
    return {
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file.path,
          message: 'Claude Code conversation file cannot be read',
          cause,
        },
      ],
    }
  }

  const parsed = await readClaudeHeadRecords(file.path, root, context)
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
          message: 'Claude Code conversation path cannot be resolved',
          cause,
        },
      ],
    }
  }

  return {
    summary: summarizeClaudeHeadRecords(parsed.records, root, file, canonical, stats),
    diagnostics: [],
  }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  const parsed = await readClaudeRecords(summary.source.path, summary.source.root)

  // A genuine "cannot be read" diagnostic is a real load failure — throw. But a
  // per-line PARSE diagnostic was already isolated by the JSONL reader (the good
  // records survive), so it must NOT discard the whole conversation: keep the
  // records and surface the parse diagnostics non-fatally.
  const readDiagnostic = parsed.diagnostics.find(
    (diagnostic) => diagnostic.message === 'Claude Code conversation file cannot be read',
  )
  if (readDiagnostic) {
    throw new AgentConversationLoadError(
      `Could not load Claude Code conversation from ${summary.source.path}`,
      { cause: readDiagnostic.cause },
    )
  }
  if (parsed.diagnostics.length > 0) {
    console.warn(
      `[podium] ${parsed.diagnostics.length} unparseable line(s) in Claude Code conversation ${summary.source.path} — skipped`,
    )
  }

  const messages = claudeMessages(parsed.records)
  return {
    ...summary,
    messageCount: messages.length,
    messages,
    raw: parsed.records,
    diagnostics: parsed.diagnostics,
  }
}

async function listClaudeConversationFiles(
  projectsRoot: string,
): Promise<ConversationProviderFile[]> {
  const files: ConversationProviderFile[] = []
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true })

  for (const projectDir of projectDirs.sort(compareDirentNames)) {
    if (!projectDir.isDirectory()) continue

    const projectPath = join(projectsRoot, projectDir.name)
    const entries = await readdir(projectPath, { withFileTypes: true })

    for (const entry of entries.sort(compareDirentNames)) {
      const fullPath = join(projectPath, entry.name)

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fullPath })
        continue
      }

      if (!entry.isDirectory()) continue

      const subagentsDir = join(fullPath, 'subagents')
      if (!(await pathExists(subagentsDir))) continue

      const subagents = await readdir(subagentsDir, { withFileTypes: true })
      for (const subagent of subagents.sort(compareDirentNames)) {
        if (subagent.isFile() && subagent.name.endsWith('.jsonl')) {
          files.push({
            path: join(subagentsDir, subagent.name),
            parentConversationId: entry.name,
          })
        }
      }
    }
  }

  return files
}

async function readClaudeHeadRecords(
  file: string,
  root: string,
  context: ProviderSummaryContext,
): Promise<{ records: unknown[]; diagnostics: AgentConversationDiagnostic[] }> {
  try {
    return await readJsonLinesHead(
      file,
      { providerId, root, path: file },
      {
        ...(context.headBytes === undefined ? {} : { maxBytes: context.headBytes }),
        ...(context.headLines === undefined ? {} : { maxLines: context.headLines }),
      },
    )
  } catch (cause) {
    return {
      records: [],
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file,
          message: 'Claude Code conversation file cannot be read',
          cause,
        },
      ],
    }
  }
}

async function readClaudeRecords(
  file: string,
  root: string,
): Promise<{ records: unknown[]; diagnostics: AgentConversationDiagnostic[] }> {
  try {
    const text = await readFile(file, 'utf8')
    return parseJsonLines(text, { providerId, root, path: file })
  } catch (cause) {
    return {
      records: [],
      diagnostics: [
        {
          severity: 'warning',
          providerId,
          root,
          path: file,
          message: 'Claude Code conversation file cannot be read',
          cause,
        },
      ],
    }
  }
}

function summarizeClaudeHeadRecords(
  records: unknown[],
  root: string,
  file: ConversationProviderFile,
  canonical: string,
  stats: ConversationFileStat,
): AgentConversationSummary {
  const summaryRecord = records.find(
    (record) => isRecord(record) && stringField(record, 'customTitle'),
  )
  const sessionRecord = records.find(
    (record) => isRecord(record) && stringField(record, 'sessionId'),
  )
  const summary = isRecord(summaryRecord) ? summaryRecord : undefined
  const session = isRecord(sessionRecord) ? sessionRecord : undefined
  // Subagent transcripts stamp every record with the PARENT conversation's
  // sessionId — trusting it would collide the child with its parent in the
  // conversation registry (the subagent's path then overwrites the parent's
  // segment path, and reattach classifies the wrong transcript — issue #94).
  // The filename is the subagent's own identity.
  const id = file.parentConversationId
    ? basename(file.path, '.jsonl')
    : (stringField(session ?? {}, 'sessionId') ?? basename(file.path, '.jsonl'))

  // Title preference: the conversation's native customTitle, else the start of
  // the first human prompt (a filename like "a1b2c3d4.jsonl" is useless in the
  // resume picker), else the bare filename as a last resort.
  const nativeTitle = stringField(summary ?? {}, 'customTitle')
  const promptTitle = nativeTitle ? undefined : firstUserPrompt(records)
  return {
    id,
    agentKind: 'claude-code',
    title: nativeTitle ?? promptTitle ?? basename(file.path, '.jsonl'),
    titleSource: nativeTitle ? 'native' : promptTitle ? 'heuristic' : 'filename',
    projectPath: firstProjectPath(records),
    parentConversationId: file.parentConversationId,
    statusHint: 'unknown',
    createdAt: firstRecordTimestamp(records) ?? createdAtFromStats(stats),
    updatedAt: validDate(stats.mtime, stats.mtimeMs),
    sizeBytes: stats.size,
    resume: { kind: 'claude-session', value: id },
    source: {
      providerId,
      root,
      path: canonical,
      relatedPaths: file.parentConversationId ? [subagentMetaPath(canonical)] : undefined,
    },
  }
}

/**
 * The first human prompt, condensed to a one-line title (≤100 chars). Skips
 * tool/command wrapper messages (Claude logs these as `user` records whose text
 * is XML-ish), so the title is the words the person actually typed.
 */
function firstUserPrompt(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.message)) continue
    if (mapConversationRole(record.message.role) !== 'user') continue
    const text = contentToText(record.message.content).replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith('<')) continue
    return text.length > 100 ? `${text.slice(0, 100)}…` : text
  }
  return undefined
}

function claudeMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.message)) continue

    messages.push({
      role: mapConversationRole(record.message.role),
      content: contentToText(record.message.content),
      createdAt: recordTimestamp(record),
      raw: record,
    })
  }

  return messages
}

function firstProjectPath(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record)) continue
    const cwd = stringField(record, 'cwd')
    if (cwd) return cwd
  }

  return undefined
}

function firstRecordTimestamp(records: unknown[]): Date | undefined {
  for (const record of records) {
    const timestamp = recordTimestamp(record)
    if (timestamp) return timestamp
  }
  return undefined
}

function recordTimestamp(record: unknown): Date | undefined {
  return isRecord(record) ? dateField(record, 'timestamp') : undefined
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

function subagentMetaPath(path: string): string {
  return join(dirname(path), `${basename(path, '.jsonl')}.meta.json`)
}

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
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
