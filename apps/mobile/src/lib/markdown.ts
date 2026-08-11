import { anyRefMatcher, parseAnyRef } from '@podium/protocol'
import { marked } from 'marked'

export interface MarkdownToken {
  type: string
  raw?: string
  text?: string
  depth?: number
  lang?: string
  href?: string
  title?: string | null
  ordered?: boolean
  start?: number | string
  task?: boolean
  checked?: boolean
  tokens?: MarkdownToken[]
  items?: MarkdownToken[]
  header?: MarkdownTableCell[]
  rows?: MarkdownTableCell[][]
  align?: Array<'left' | 'center' | 'right' | null>
}

export interface MarkdownTableCell {
  text: string
  tokens: MarkdownToken[]
  header: boolean
  align: 'left' | 'center' | 'right' | null
}

export type PodiumRefPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'ref'
      text: string
      ref: string
      /** Issue (`POD-529`) or session (`POD-13-A`, `POD-DRAFT-3`) — a session is
       *  never painted with a workflow stage (POD-724). */
      refKind: 'issue' | 'session'
      /** The repo prefix, so the renderer can tell a real ref from `UTF-8`. */
      prefix: string
      offset: number
    }

/** Parse GFM into data rather than HTML so native renderers never need a DOM sanitizer. */
export function parseMarkdown(text: string): MarkdownToken[] {
  return marked.lexer(text, { gfm: true, breaks: true }) as MarkdownToken[]
}

/**
 * Preserve the task-peek interaction when references appear inside formatted
 * Markdown.
 *
 * The grammar is the PROTOCOL's (`anyRefMatcher`), not a phone-local
 * `POD-\d+` (POD-724). A second regex here is how the phone came to see only
 * one repo's issues and no sessions at all: `ACME-14` read as prose and
 * `POD-13-A` split into a fake issue ref `POD-13` followed by `-A`. Splitting
 * says only "this token is ref-SHAPED" — whether the prefix belongs to a real
 * repo is a live-data question the renderer answers, the same division the
 * desktop draws between `anyRefMatcher` and its known-prefix set.
 */
export function splitPodiumRefs(text: string): PodiumRefPart[] {
  const parts: PodiumRefPart[] = []
  let at = 0
  for (const match of text.matchAll(anyRefMatcher())) {
    const ref = match[0]
    const parsed = parseAnyRef(ref)
    if (!parsed) continue
    const index = match.index ?? 0
    if (index > at) parts.push({ kind: 'text', text: text.slice(at, index) })
    parts.push({
      kind: 'ref',
      text: ref,
      ref,
      refKind: parsed.kind,
      prefix: parsed.prefix,
      offset: index,
    })
    at = index + ref.length
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) })
  return parts.length > 0 ? parts : [{ kind: 'text', text }]
}

/** Only schemes that the native OS should handle may become tappable transcript links. */
export function safeExternalUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}
