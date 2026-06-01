import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  contentToText,
  dateField,
  isRecord,
  mapConversationRole,
  parseJsonLines,
  stringField,
} from '../jsonl.js'
import { canonicalPath, pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationProvider,
  ProviderScanResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'

const providerId = 'claude-code-jsonl'

type ClaudeConversationFile = {
  path: string
  parentConversationId?: string
}

export function createClaudeCodeConversationProvider(): ConversationProvider {
  return {
    id: providerId,
    agentKind: 'claude-code',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.claude')],
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const projectsRoot = join(root, 'projects')
  if (!(await pathExists(projectsRoot))) return { conversations: [], diagnostics: [] }

  let files: ClaudeConversationFile[]
  try {
    files = await listClaudeConversationFiles(projectsRoot)
  } catch (cause) {
    return {
      conversations: [],
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

  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = []

  for (const file of files) {
    const parsed = await readClaudeRecords(file.path, root)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.diagnostics.length > 0) continue

    const summary = await summarizeClaudeRecords(parsed.records, root, file)
    if (summary) conversations.push(summary)
  }

  return { conversations, diagnostics }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  const parsed = await readClaudeRecords(summary.source.path, summary.source.root)

  if (parsed.diagnostics.length > 0) {
    const readDiagnostic = parsed.diagnostics.find(
      (diagnostic) => diagnostic.message === 'Claude Code conversation file cannot be read',
    )
    if (readDiagnostic) {
      throw new AgentConversationLoadError(
        `Could not load Claude Code conversation from ${summary.source.path}`,
        { cause: readDiagnostic.cause },
      )
    }

    throw new AgentConversationLoadError(
      `Could not parse Claude Code conversation ${summary.source.path}`,
    )
  }

  return { ...summary, messages: claudeMessages(parsed.records), raw: parsed.records }
}

async function listClaudeConversationFiles(projectsRoot: string): Promise<ClaudeConversationFile[]> {
  const files: ClaudeConversationFile[] = []
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

async function summarizeClaudeRecords(
  records: unknown[],
  root: string,
  file: ClaudeConversationFile,
): Promise<AgentConversationSummary | undefined> {
  const messages = claudeMessages(records)
  const summaryRecord = records.find(
    (record) => isRecord(record) && stringField(record, 'customTitle'),
  )
  const sessionRecord = records.find((record) => isRecord(record) && stringField(record, 'sessionId'))
  if (messages.length === 0 && !summaryRecord && !sessionRecord) return undefined

  const canonical = await canonicalPath(file.path)
  const summary = isRecord(summaryRecord) ? summaryRecord : undefined
  const session = isRecord(sessionRecord) ? sessionRecord : undefined
  const id = stringField(session ?? {}, 'sessionId') ?? basename(file.path, '.jsonl')
  const dates = records.map(recordTimestamp).filter((date): date is Date => date !== undefined)

  return {
    id,
    agentKind: 'claude-code',
    title: stringField(summary ?? {}, 'customTitle') ?? basename(file.path, '.jsonl'),
    titleSource: summary ? 'native' : 'filename',
    projectPath: firstProjectPath(records),
    parentConversationId: file.parentConversationId,
    statusHint: 'unknown',
    createdAt: dates[0],
    updatedAt: dates.at(-1),
    messageCount: messages.length,
    resume: { kind: 'claude-session', value: id },
    source: {
      providerId,
      root,
      path: canonical,
      relatedPaths: file.parentConversationId ? [subagentMetaPath(canonical)] : undefined,
    },
  }
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

function recordTimestamp(record: unknown): Date | undefined {
  return isRecord(record) ? dateField(record, 'timestamp') : undefined
}

function subagentMetaPath(path: string): string {
  return join(dirname(path), `${basename(path, '.jsonl')}.meta.json`)
}

function compareDirentNames(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}
