import { marked, type Tokens } from 'marked'

// This module is deliberately DOM-free. It is imported by the browser main
// thread and by the transcript Worker; sanitation, link activation, and DOM
// policy stay in markdown.ts on the browser thread.
marked.setOptions({ gfm: true, breaks: true })

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Colourize unified-diff code blocks (```diff / ```patch, or an unlabelled
// block that clearly is one). Copy affordance injection remains part of the
// shared unsafe render, while the click handler stays in the DOM host.
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

/** Markdown → unsafe HTML. Never put this string directly into the DOM. */
export function renderMarkdownUnsafe(text: string): string {
  return marked.parse(text, { async: false })
}
