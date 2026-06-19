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
 * Markdown → sanitized HTML, each top-level block wrapped in
 * `<div class="md-block" data-source-line="N">`. The line map drives split-view
 * scroll sync and the future line-annotation feature.
 */
export function renderMarkdownBlocks(text: string, opts: RenderBlocksOptions = {}): string {
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
  const withImages = rewriteImageSrc(linkifyCodePaths(out), opts.resolveAsset)
  // DOMPurify keeps data-* attributes and class by default (matches markdown.ts).
  // We must allow DIV tags; DOMPurify's default config needs explicit ALLOWED_TAGS.
  // Wrap in a container to prevent DOMPurify from unwrapping outer divs.
  const wrapped = `<div class="md-blocks-container">${withImages}</div>`
  const config = {
    ALLOWED_TAGS: ['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'em', 'strong', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr', 'span', 'input'],
    ALLOWED_ATTR: ['class', 'data-source-line', 'href', 'src', 'alt', 'title', 'type', 'checked', 'disabled']
  }
  const sanitized = DOMPurify.sanitize(wrapped, config)
  // Unwrap the container
  const containerStart = '<div class="md-blocks-container">'
  const containerEnd = '</div>'
  return sanitized.startsWith(containerStart) && sanitized.endsWith(containerEnd)
    ? sanitized.slice(containerStart.length, -containerEnd.length)
    : sanitized
}
