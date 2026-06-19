import DOMPurify from 'dompurify'
import { marked } from 'marked'
// Importing markdown.ts applies the shared marked config (gfm/breaks + diff-aware
// code renderer) as a module side effect, and gives us the file-path linkifier.
import { linkifyCodePaths } from './markdown'

export interface RenderBlocksOptions {
  /** Map a relative image src to a servable URL; return null to leave it as-is. */
  resolveAsset?: (src: string) => string | null
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1
  return n
}

// Rewrite relative <img src>. Absolute (http/https/data/blob), protocol-relative,
// and root-absolute srcs are left untouched.
function rewriteImageSrc(html: string, resolveAsset?: (src: string) => string | null): string {
  if (!resolveAsset) return html
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/g, (full, pre: string, src: string, post: string) => {
    if (/^(https?:|data:|blob:|\/\/|\/)/i.test(src)) return full
    const url = resolveAsset(src)
    return url ? `${pre}${url}${post}` : full
  })
}

/**
 * Assemble (but do NOT sanitize) markdown into HTML where each top-level block is
 * wrapped in `<div class="md-block" data-source-line="N">` (N = 1-based source line).
 * Pure and deterministic — this is the unit that carries the source-line map and is
 * tested directly. Sanitization is a separate, browser-dependent step (see
 * renderMarkdownBlocks).
 */
export function assembleMarkdownBlocks(text: string, opts: RenderBlocksOptions = {}): string {
  const tokens = marked.lexer(text)
  let offset = 0
  let out = ''
  for (const token of tokens) {
    const line = countNewlines(text.slice(0, offset)) + 1
    const single = [token] as typeof tokens
    // Carry reference-link definitions collected during lexing so reflinks resolve.
    ;(single as unknown as { links?: unknown }).links = (tokens as unknown as { links?: unknown }).links
    const inner = marked.parser(single)
    offset += token.raw.length
    if (!inner.trim()) continue // skip whitespace-only 'space' tokens
    out += `<div class="md-block" data-source-line="${line}">${inner}</div>`
  }
  return rewriteImageSrc(linkifyCodePaths(out), opts.resolveAsset)
}

/**
 * Markdown → sanitized HTML for rendering in the browser. Uses DOMPurify's default
 * policy — exactly like markdown.ts's renderMarkdown — so it keeps <div>, class, and
 * the data-source-line anchors in a real browser, with no lossy allowlist.
 */
export function renderMarkdownBlocks(text: string, opts: RenderBlocksOptions = {}): string {
  return DOMPurify.sanitize(assembleMarkdownBlocks(text, opts))
}
