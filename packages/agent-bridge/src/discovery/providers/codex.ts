import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  contentToText,
  dateField,
  isRecord,
  mapConversationRole,
  parseJsonLines,
  readJsonLinesHead,
  stringField,
} from '../jsonl.js'
import { canonicalPath, listFilesRecursive, pathExists } from '../paths.js'
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
import {
  type CodexStateMetadataResult,
  type CodexThreadMetadata,
  readCodexStateMetadata,
} from './codex-state.js'

const providerId = 'codex-jsonl'

export function createCodexConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'codex',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.codex')],
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
      const result = await summarizeFile(root, file, {
        canonicalPath: canonical,
        rootState: listing.state,
      })
      diagnostics.push(...result.diagnostics)
      if (result.summary) conversations.push(result.summary)
    }),
  )

  return { conversations, diagnostics }
}

async function listRoot(root: string): Promise<ProviderRootListing> {
  const sessionsRoot = join(root, 'sessions')
  const state = await readCodexStateMetadata(root)
  if (!(await pathExists(sessionsRoot))) {
    return { files: [], diagnostics: state.diagnostics, state }
  }

  try {
    const files = await listFilesRecursive(sessionsRoot, (file) => file.endsWith('.jsonl'))
    return { files: files.map((path) => ({ path })), diagnostics: state.diagnostics, state }
  } catch (cause) {
    return {
      files: [],
      diagnostics: [
        ...state.diagnostics,
        {
          severity: 'error',
          providerId,
          root,
          message: 'Codex sessions directory cannot be read',
          cause,
        },
      ],
      state,
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
          message: 'Codex session file cannot be read',
          cause,
        },
      ],
    }
  }

  const parsed = await readCodexHeadRecords(file.path, root, context)
  if (parsed.diagnostics.length > 0) return { diagnostics: parsed.diagnostics }
  if (parsed.records.length === 0 && stats.size === 0) return { diagnostics: [] }

  // Codex ≥0.142 writes a SECOND rollout per interactive session for its internal
  // "guardian" risk-judging subagent (`source: { subagent }`). It's not a user
  // conversation — drop it so the history list doesn't fill with phantom "judging
  // one planned action" entries. (The live observer excludes it too; see
  // isInteractiveCodexSource.)
  const sessionMeta = parsed.records.map(codexPayload).find((p) => stringField(p, 'id'))
  if (sessionMeta && isCodexSubagentSource(sessionMeta.source)) return { diagnostics: [] }

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
          message: 'Codex session path cannot be resolved',
          cause,
        },
      ],
    }
  }

  const state = isCodexStateMetadataResult(context.rootState)
    ? context.rootState
    : await readCodexStateMetadata(root)
  const metadata = state.byRolloutPath.get(canonical) ?? state.byRolloutPath.get(file.path)

  return {
    summary: summarizeCodexHeadRecords(parsed.records, root, canonical, metadata, stats),
    diagnostics: state === context.rootState ? [] : state.diagnostics,
  }
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

  // A genuine "cannot be read" diagnostic is a real load failure — throw. Per-line
  // PARSE diagnostics were already isolated by the JSONL reader (good records
  // survive), so keep the records and surface those diagnostics non-fatally.
  const readDiagnostic = parsed.diagnostics.find(
    (diagnostic) => diagnostic.message === 'Codex session file cannot be read',
  )
  if (readDiagnostic) {
    throw new AgentConversationLoadError(
      `Could not load Codex conversation from ${summary.source.path}`,
      { cause: readDiagnostic.cause },
    )
  }
  if (parsed.diagnostics.length > 0) {
    console.warn(
      `[podium] ${parsed.diagnostics.length} unparseable line(s) in Codex conversation ${summary.source.path} — skipped`,
    )
  }

  const messages = codexMessages(parsed.records)
  return {
    ...summary,
    messageCount: messages.length,
    messages,
    raw: parsed.records,
    diagnostics: parsed.diagnostics,
  }
}

async function readCodexHeadRecords(
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
          message: 'Codex session file cannot be read',
          cause,
        },
      ],
    }
  }
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
          message: 'Codex session file cannot be read',
          cause,
        },
      ],
    }
  }
}

function summarizeCodexHeadRecords(
  records: unknown[],
  root: string,
  file: string,
  metadata: CodexThreadMetadata | undefined,
  stats: ConversationFileStat,
): AgentConversationSummary {
  const meta = records.map(codexPayload).find((payload) => stringField(payload, 'id'))
  const id =
    metadata?.id ?? (meta ? stringField(meta, 'id') : undefined) ?? basename(file, '.jsonl')

  // With no native thread title, fall back to the first human prompt (like the
  // Claude provider) so an untitled session reads as what it's about, not a uuid.
  const promptTitle = metadata?.title ? undefined : firstCodexPrompt(records)

  return {
    id,
    agentKind: 'codex',
    title: metadata?.title ?? promptTitle ?? fallbackTitle(file),
    titleSource: metadata?.title ? 'native' : promptTitle ? 'heuristic' : 'filename',
    projectPath: metadata?.cwd ?? (meta ? stringField(meta, 'cwd') : undefined),
    parentConversationId: metadata?.parentThreadId,
    statusHint: metadata?.archived ? 'archived' : 'unknown',
    createdAt: firstRecordTimestamp(records) ?? createdAtFromStats(stats),
    updatedAt: validDate(stats.mtime, stats.mtimeMs),
    sizeBytes: stats.size,
    git: metadata?.git,
    resume: { kind: 'codex-thread', value: id },
    source: {
      providerId,
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

/**
 * True when a `session_meta.source` describes an interactive Codex TUI session —
 * the one a Podium pane actually runs. Codex (≥0.142) writes a SECOND rollout per
 * interactive session for its internal "guardian" risk-judging subagent: same cwd,
 * newer mtime, its own thread id, but `source: { subagent: … }`. `codex exec` runs
 * carry `source: 'exec'`. Only `'cli'` is the interactive session; treating the
 * guardian rollout as the session's cross-wires the chat view to its transcript.
 * A missing source (older Codex) is treated as interactive for backward-compat.
 */
export function isInteractiveCodexSource(source: unknown): boolean {
  return source === undefined || source === null || source === 'cli'
}

/** True for a subagent rollout (e.g. Codex's "guardian"): `source: { subagent }`. */
export function isCodexSubagentSource(source: unknown): boolean {
  return isRecord(source) && 'subagent' in source
}

/**
 * Condense raw title text to a clean one-line title, or undefined when it's empty
 * or an injected `<…>` preamble rather than something a person typed.
 *
 * Codex has no auto-generated short title — its `threads.title` (and `preview` /
 * `first_user_message`) are just the raw first message, often a long voice-typed
 * run-on. So the best "readout" is the tidy head of that: collapse whitespace,
 * prefer the first sentence when it ends early, and otherwise cut at a word
 * boundary (≤80 chars) instead of mid-word.
 */
export function cleanCodexTitle(raw: string | undefined): string | undefined {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text || text.startsWith('<')) return undefined
  const sentence = text.match(/^.{15,80}?[.!?](?=\s|$)/)?.[0]
  if (sentence) return sentence
  if (text.length <= 80) return text
  const cut = text.slice(0, 80)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 48 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * One rollout record → a one-line title from a human-typed prompt, or undefined.
 * Reads only `event_msg.user_message` events — the clean text the person actually
 * typed — so the injected AGENTS.md / permissions preamble (which arrives as a
 * `response_item` user record) never becomes the title. Shared by the history
 * summary (first match wins) and the live state observer (first prompt seen).
 */
export function codexPromptTitle(record: unknown): string | undefined {
  if (!isRecord(record) || stringField(record, 'type') !== 'event_msg') return undefined
  const payload = codexPayload(record)
  if (stringField(payload, 'type') !== 'user_message') return undefined
  return cleanCodexTitle(stringField(payload, 'message') ?? contentToText(payload.text_elements))
}

/** The first human-typed prompt across `records`, condensed to a one-line title. */
function firstCodexPrompt(records: unknown[]): string | undefined {
  for (const record of records) {
    const title = codexPromptTitle(record)
    if (title) return title
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
  if (!isRecord(record)) return undefined
  const timestamp = dateField(record, 'timestamp')
  if (timestamp) return timestamp
  return dateField(codexPayload(record), 'timestamp')
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

function fallbackTitle(file: string): string {
  return basename(file, '.jsonl')
}

function isCodexStateMetadataResult(value: unknown): value is CodexStateMetadataResult {
  return (
    isRecord(value) &&
    value.byThreadId instanceof Map &&
    value.byRolloutPath instanceof Map &&
    Array.isArray(value.diagnostics)
  )
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
