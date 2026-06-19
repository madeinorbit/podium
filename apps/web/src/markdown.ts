import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

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
  return `<pre class="chat-diff"><code>${body}</code></pre>`
}

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().toLowerCase()
      const looksLikeDiff = language === '' && /^@@ /m.test(text) && /^[+-]/m.test(text)
      if (language === 'diff' || language === 'patch' || looksLikeDiff) return renderDiff(text)
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ''
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`
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

/** Markdown → sanitized HTML. The single render path for all chat surfaces. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(linkifyCodePaths(marked.parse(text, { async: false })))
}
