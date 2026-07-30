import { anyRefMatcher, parseAnyRef } from '@podium/protocol'
import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

// External links in a transcript should open in a new tab — clicking one must
// never navigate away from Podium. file-link anchors (internal file opens) carry
// data-path and no href, so keying on href leaves them in-window. Runs on the
// already-sanitized HTML, so any dangerous href scheme has been stripped first;
// this only appends target/rel and never introduces markup.
export function externalizeLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>/g, (full, attrs: string) => {
    if (!/\bhref=/.test(attrs)) return full // internal file-link (no href)
    if (/\btarget=/.test(attrs)) return full // already targeted
    return `<a${attrs} target="_blank" rel="noopener noreferrer">`
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Colourize unified-diff code blocks (```diff / ```patch, or an unlabelled block
// that clearly is one). Agents emit diffs constantly, and line-level +/- colour
// reads far more natively than a flat grey block — the readability win we can
// offer outside a terminal. Other code blocks render escaped, as before.
// Copy affordance injected into every rendered code block. Empty button (the icon
// is a CSS mask, so it survives DOMPurify untouched); the click handler reads the
// sibling <code> text at click time, so the code isn't duplicated into the markup.
// Handled by handleCodeCopyClick on the chat/preview containers.
const COPY_BUTTON =
  '<button type="button" class="code-copy" aria-label="Copy code" title="Copy"></button>'

function renderDiff(text: string): string {
  const body = text
    .split('\n')
    .map((line) => {
      const cls =
        line.startsWith('+') && !line.startsWith('+++')
          ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : ''
      const html = escapeHtml(line)
      return cls ? `<span class="${cls}">${html}</span>` : html
    })
    .join('\n')
  return `<pre class="chat-diff"><code>${body}</code>${COPY_BUTTON}</pre>`
}

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().toLowerCase()
      const looksLikeDiff = language === '' && /^@@ /m.test(text) && /^[+-]/m.test(text)
      if (language === 'diff' || language === 'patch' || looksLikeDiff) return renderDiff(text)
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ''
      return `<pre><code${cls}>${escapeHtml(text)}</code>${COPY_BUTTON}</pre>`
    },
  },
})

// A token looks like a file path if it has a directory separator or a known
// code-file extension. Conservative on purpose — the backtick is the intent
// signal; this only filters out non-file code spans (commands, identifiers).
const PATHISH =
  /^[\w./@~-]+\/[\w./@~-]+$|^[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)$/

export function linkifyCodePaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (full, inner: string) => {
    const token = inner.trim()
    if (!PATHISH.test(token)) return full
    return `<code><a class="file-link" data-path="${token}">${inner}</a></code>`
  })
}

// The set of registered repo prefixes (#474). Only tokens whose prefix matches
// one of these are linkified — this is what keeps `UTF-8` and other real hyphens
// from turning into dead ref links. The app updates it whenever the repo list
// loads; empty (the default) disables ref linkification entirely.
let knownRefPrefixes = new Set<string>()

/** Update the registered repo prefixes the ref linkifier recognises (#474). */
export function setKnownRefPrefixes(prefixes: Iterable<string>): void {
  knownRefPrefixes = new Set(prefixes)
}

/** The registered repo prefixes (#474). Shared with the terminal link provider so
 *  markdown and terminal linkify agree on which tokens are real refs. */
export function getKnownRefPrefixes(): ReadonlySet<string> {
  return knownRefPrefixes
}

/** Whether `prefix` is a registered repo prefix (#474). */
export function isKnownRefPrefix(prefix: string): boolean {
  return knownRefPrefixes.has(prefix)
}

/**
 * Turn `PREFIX-N` / `PREFIX-N-LETTER` / `PREFIX-DRAFT-N` tokens into ref anchors
 * (#474), analogous to {@link linkifyCodePaths}. Runs on sanitized HTML and only
 * rewrites TEXT nodes — never inside an existing `<a>` or `<code>`, and never a
 * tag's own attributes — so it can't double-link or corrupt markup. Only tokens
 * whose prefix is a registered repo prefix become links.
 *
 * Emits `<a class="ref-link ref-link--issue" data-ref="POD-13">POD-13</a>` (no
 * href, so externalizeLinks leaves it in-window); the click handler reads
 * data-ref. The kind modifier picks the chip icon (issue vs session).
 */
export function linkifyRefs(html: string): string {
  if (knownRefPrefixes.size === 0) return html
  const parts = html.split(/(<[^>]+>)/)
  let inAnchor = 0
  let inCode = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.startsWith('<')) {
      if (/^<a\b/i.test(p)) inAnchor++
      else if (/^<\/a>/i.test(p)) inAnchor = Math.max(0, inAnchor - 1)
      else if (/^<code\b/i.test(p)) inCode++
      else if (/^<\/code>/i.test(p)) inCode = Math.max(0, inCode - 1)
      continue
    }
    if (inAnchor > 0 || inCode > 0 || p === '') continue
    parts[i] = p.replace(anyRefMatcher(), (tok) => {
      const ref = parseAnyRef(tok)
      if (!ref || !knownRefPrefixes.has(ref.prefix)) return tok
      return `<a class="ref-link ref-link--${ref.kind}" data-ref="${tok}">${tok}</a>`
    })
  }
  return parts.join('')
}

/** Markdown → sanitized HTML. The single render path for all chat surfaces. */
export function renderMarkdown(text: string): string {
  const rendered = linkifyCodePaths(marked.parse(text, { async: false }))
  return externalizeLinks(linkifyRefs(DOMPurify.sanitize(rendered)))
}
