import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@podium/runtime/sqlite'
import { parseJsonLines, readJsonLinesHead } from '../../discovery/jsonl.js'
import type {
  AgentConversationSummary,
  ConversationProvider,
  ProviderRootListing,
} from '../../discovery/types.js'
import { isRecord } from '../shared/json-util.js'
import { CONVERSATION_ID } from './paths.js'
import { antigravityRecordToItems } from './transcript.js'

const providerId = 'antigravity-brain'
type SummaryMetadata = { title?: string; cwd?: string; parent?: string }

/** Read only the native summary index, never the opaque conversation bodies. */
function metadata(root: string): Map<string, SummaryMetadata> {
  const result = new Map<string, SummaryMetadata>()
  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(join(root, 'conversation_summaries.db'), { readOnly: true })
    const rows = db
      .prepare(
        'SELECT conversation_id, title, workspace_uris, parent_conversation_id FROM conversation_summaries',
      )
      .all() as Record<string, unknown>[]
    for (const row of rows) {
      if (typeof row.conversation_id !== 'string') continue
      let cwd: string | undefined
      try {
        const uris: unknown = JSON.parse(String(row.workspace_uris))
        if (Array.isArray(uris) && typeof uris[0] === 'string')
          cwd = uris[0].startsWith('file:') ? fileURLToPath(uris[0]) : uris[0]
      } catch {
        /* A malformed workspace list must not hide the transcript. */
      }
      result.set(row.conversation_id, {
        ...(typeof row.title === 'string' && row.title ? { title: row.title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(typeof row.parent_conversation_id === 'string' && row.parent_conversation_id
          ? { parent: row.parent_conversation_id }
          : {}),
      })
    }
  } catch {
    /* Older agy builds have no SQLite summary index. */
  } finally {
    db?.close()
  }
  return result
}

export async function listAntigravityTranscripts(root: string): Promise<ProviderRootListing> {
  const files: ProviderRootListing['files'] = []
  try {
    for (const entry of await readdir(join(root, 'brain'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !CONVERSATION_ID.test(entry.name)) continue
      const logs = join(root, 'brain', entry.name, '.system_generated', 'logs')
      for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const path = join(logs, name)
        try {
          if ((await stat(path)).isFile()) {
            files.push({ path })
            break
          }
        } catch {
          /* A conversation may not have written its first log. */
        }
      }
    }
  } catch (cause) {
    if (!isRecord(cause) || cause.code !== 'ENOENT')
      return {
        files,
        diagnostics: [
          {
            severity: 'warning',
            providerId,
            root,
            message: 'Antigravity transcripts cannot be listed',
            cause,
          },
        ],
      }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), diagnostics: [] }
}

export function createAntigravityConversationProvider(): ConversationProvider {
  const provider: ConversationProvider = {
    id: providerId,
    agentKind: 'antigravity',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.gemini', 'antigravity-cli')],
    listRoot: async (root) => ({
      ...(await listAntigravityTranscripts(root)),
      state: metadata(root),
    }),
    async summarizeFile(root, file, context = {}) {
      try {
        const info = context.stats ?? (await stat(file.path))
        const parsed = await readJsonLinesHead(file.path, { providerId, root, path: file.path })
        const id = basename(dirname(dirname(dirname(file.path))))
        if (!CONVERSATION_ID.test(id)) return { diagnostics: parsed.diagnostics }
        const native = (
          context.rootState instanceof Map
            ? (context.rootState as Map<string, SummaryMetadata>)
            : metadata(root)
        ).get(id)
        const first = parsed.records
          .flatMap(antigravityRecordToItems)
          .find((item) => item.role === 'user')
        const summary: AgentConversationSummary = {
          id,
          agentKind: 'antigravity',
          title: native?.title ?? first?.text.slice(0, 120) ?? id,
          titleSource: native?.title ? 'native' : 'heuristic',
          ...(native?.cwd ? { projectPath: native.cwd } : {}),
          ...(native?.parent ? { parentConversationId: native.parent } : {}),
          createdAt: first?.ts ? new Date(first.ts) : info.birthtime,
          updatedAt: info.mtime,
          sizeBytes: info.size,
          resume: { kind: 'antigravity-conversation', value: id },
          source: { providerId, root, path: file.path },
        }
        return { summary, diagnostics: parsed.diagnostics }
      } catch (cause) {
        return {
          diagnostics: [
            {
              severity: 'warning',
              providerId,
              root,
              path: file.path,
              message: 'Antigravity transcript cannot be read',
              cause,
            },
          ],
        }
      }
    },
    async scanRoot(root) {
      const listing = await provider.listRoot(root)
      const conversations: AgentConversationSummary[] = []
      const diagnostics = [...listing.diagnostics]
      for (const file of listing.files) {
        const result = await provider.summarizeFile(root, file, { rootState: listing.state })
        diagnostics.push(...result.diagnostics)
        if (result.summary) conversations.push(result.summary)
      }
      return { conversations, diagnostics }
    },
    async loadConversation(summary) {
      const parsed = parseJsonLines(await readFile(summary.source.path, 'utf8'), {
        providerId,
        root: summary.source.root,
        path: summary.source.path,
      })
      const items = parsed.records.flatMap((record, index) =>
        antigravityRecordToItems(record, parsed.records[index - 1]),
      )
      return {
        ...summary,
        messageCount: items.length,
        messages: items.map((item) => ({
          role: item.role,
          content: item.text || item.toolResult || item.toolInput || '',
          ...(item.ts ? { createdAt: new Date(item.ts) } : {}),
        })),
        diagnostics: parsed.diagnostics,
      }
    },
  }
  return provider
}
