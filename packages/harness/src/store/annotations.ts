import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import type { TranscriptSource } from './source'

/**
 * TRANSCRIPT ANNOTATIONS (POD-6258): items a driver learned live that its
 * harness never writes into its own transcript.
 *
 * Every history read re-parses the harness's own files, so an item that only
 * ever crossed the live stream disappears on the next reload. A driver that
 * wants such an item to last appends it here; the daemon's read layer weaves
 * the log back into every slice it serves. The log is Podium's, keyed by the
 * Podium session id, and the reader never names a harness: a driver for any
 * harness may write it, and a session that never wrote one reads unchanged.
 *
 * Placement is by tool-use id rather than by cursor. An annotation sits right
 * after the last item in a slice that carries its anchor id, and carries no
 * cursor of its own: it is not a position in the harness's file, and the
 * slice's head/tail cursors stay the harness's.
 */
export interface TranscriptAnnotation {
  /** Woven directly after the last slice item carrying this tool-use id. */
  readonly afterToolUseId: string
  readonly item: TranscriptItem
}

export interface TranscriptAnnotationStore {
  append(sessionId: string, annotation: TranscriptAnnotation): Promise<void>
  read(sessionId: string): Promise<readonly TranscriptAnnotation[]>
}

/**
 * A harness's own summary of a batch of tool calls, as an annotation. Any
 * driver whose harness reports such summaries builds them here, so the item
 * shape is the same whichever harness produced it.
 */
export function toolSummaryAnnotation(input: {
  /** Stable across the live publish and every later read. */
  id: string
  text: string
  /** The calls it covers, in call order. Must not be empty. */
  toolUseIds: readonly string[]
  ts?: string
}): TranscriptAnnotation | undefined {
  const text = input.text.trim()
  const last = input.toolUseIds.at(-1)
  if (!text || last === undefined) return undefined
  return {
    afterToolUseId: last,
    item: {
      id: input.id,
      role: 'system',
      systemKind: 'tool-summary',
      text,
      summarizes: [...input.toolUseIds],
      ...(input.ts ? { ts: input.ts } : {}),
    },
  }
}

/** Put each annotation after its anchor; annotations whose anchor is not in
 *  this slice belong to another slice and are left out. Pure. */
export function weaveAnnotations(
  items: readonly TranscriptItem[],
  annotations: readonly TranscriptAnnotation[],
): TranscriptItem[] {
  if (annotations.length === 0 || items.length === 0) return [...items]
  const byAnchor = new Map<string, TranscriptItem[]>()
  for (const { afterToolUseId, item } of annotations) {
    const list = byAnchor.get(afterToolUseId)
    if (list) list.push(item)
    else byAnchor.set(afterToolUseId, [item])
  }
  const last = new Map<string, number>()
  const present = new Set<string>()
  items.forEach((item, at) => {
    present.add(item.id)
    if (item.toolUseId !== undefined && byAnchor.has(item.toolUseId)) last.set(item.toolUseId, at)
  })
  if (last.size === 0) return [...items]
  const woven: TranscriptItem[] = []
  items.forEach((item, at) => {
    woven.push(item)
    if (item.toolUseId === undefined || last.get(item.toolUseId) !== at) return
    for (const annotation of byAnchor.get(item.toolUseId)!) {
      if (present.has(annotation.id)) continue
      present.add(annotation.id)
      woven.push(annotation)
    }
  })
  return woven
}

/** A source whose slices carry this session's annotations. */
export function withTranscriptAnnotations(
  source: TranscriptSource,
  read: () => Promise<readonly TranscriptAnnotation[]>,
): TranscriptSource {
  return {
    async readSlice(opts) {
      const [slice, annotations] = await Promise.all([
        source.readSlice(opts),
        read().catch(() => [] as const),
      ])
      return annotations.length === 0
        ? slice
        : { ...slice, items: weaveAnnotations(slice.items, annotations) }
    },
  }
}

/**
 * One append-only JSONL file per session under `dir`. Reads are cached on the
 * file's size and mtime, so the hot read path re-parses only after an append.
 * A torn last line (a crash mid-append) is skipped, never fatal.
 */
export function transcriptAnnotationStore(dir: string): TranscriptAnnotationStore {
  const cache = new Map<string, { size: number; mtimeMs: number; list: TranscriptAnnotation[] }>()
  const pathFor = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.jsonl`)
  let made: Promise<unknown> | undefined
  return {
    async append(sessionId, annotation) {
      made ??= mkdir(dir, { recursive: true })
      await made
      await appendFile(pathFor(sessionId), `${JSON.stringify(annotation)}\n`)
    },
    async read(sessionId) {
      const path = pathFor(sessionId)
      let info: { size: number; mtimeMs: number }
      try {
        info = await stat(path)
      } catch {
        return []
      }
      const held = cache.get(sessionId)
      if (held && held.size === info.size && held.mtimeMs === info.mtimeMs) return held.list
      const list: TranscriptAnnotation[] = []
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Partial<TranscriptAnnotation>
          if (typeof parsed.afterToolUseId === 'string' && typeof parsed.item?.id === 'string')
            list.push(parsed as TranscriptAnnotation)
        } catch {
          // A torn append; the next complete line still reads.
        }
      }
      cache.set(sessionId, { size: info.size, mtimeMs: info.mtimeMs, list })
      return list
    },
  }
}
