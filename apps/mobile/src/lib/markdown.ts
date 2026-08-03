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
  | { kind: 'ref'; text: string; ref: string; offset: number }

const PODIUM_REF_RE = /\b(POD-\d+)\b/g

/** Parse GFM into data rather than HTML so native renderers never need a DOM sanitizer. */
export function parseMarkdown(text: string): MarkdownToken[] {
  return marked.lexer(text, { gfm: true, breaks: true }) as MarkdownToken[]
}

/** Preserve the task-peek interaction when references appear inside formatted Markdown. */
export function splitPodiumRefs(text: string): PodiumRefPart[] {
  const parts: PodiumRefPart[] = []
  let at = 0
  for (const match of text.matchAll(PODIUM_REF_RE)) {
    const index = match.index ?? 0
    if (index > at) parts.push({ kind: 'text', text: text.slice(at, index) })
    const ref = match[1]
    if (ref) parts.push({ kind: 'ref', text: ref, ref, offset: index })
    at = index + match[0].length
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
