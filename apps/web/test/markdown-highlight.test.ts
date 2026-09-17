import { highlightCode } from '@podium/client-core/code-highlight'
import { expect, it } from 'vitest'
import { sanitizeRenderedMarkdown } from '../src/lib/markdown'
import { createMarkdownRenderer, renderMarkdownUnsafe } from '../src/lib/markdown-renderer'

it('highlights only when the worker supplies a tokenizer and escapes source', () => {
  const source = '```ts\nconst text = "<script>alert(1)</script>"\n```'
  expect(renderMarkdownUnsafe(source)).not.toContain('hljs-')
  const html = createMarkdownRenderer(highlightCode)(source)
  expect(html).toContain('hljs-keyword')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('code-copy')
})
it('preserves explicit and inferred diffs', () => {
  const render = createMarkdownRenderer(() => {
    throw new Error('diff must bypass highlighting')
  })
  for (const label of ['diff', 'patch', '']) {
    expect(render(`\`\`\`${label}\n@@ -1 +1 @@\n-old\n+new\n\`\`\``)).toContain('diff-add')
  }
})

it('preserves worker token classes through real transcript sanitization', () => {
  const source = '```ts\nfunction greet(name: string) { return "<script>" }\n```'
  const unsafe = createMarkdownRenderer(highlightCode)(source)
  const html = sanitizeRenderedMarkdown(unsafe)
  const container = document.createElement('div')
  container.innerHTML = html
  expect(container.querySelector('code.language-ts .hljs-keyword')?.textContent).toBe('function')
  expect(container.querySelector('.hljs-title-function')?.textContent).toBe('greet')
  expect(container.querySelector('.code-copy')).not.toBeNull()
  expect(container.querySelector('code')?.textContent).toContain('"<script>"')
  expect(container.querySelector('script')).toBeNull()
})

// POD-4109: happy-dom retained both attack nodes after a highlighted fence, even
// though its first-element loss made the older image-only sanitizer guard pass.
it('strips executable markup after a highlighted fence while preserving safe elements', () => {
  const source = '```ts\nconst n = 1\n```'
  const unsafe = createMarkdownRenderer(highlightCode)(source)
  const html = sanitizeRenderedMarkdown(
    `${unsafe}<img src="x" onerror="alert(1)"><script>alert(1)</script>`,
  )
  const container = document.createElement('div')
  container.innerHTML = html
  expect(container.querySelector('pre code.language-ts .hljs-keyword')?.textContent).toBe('const')
  expect(container.querySelector('img')?.getAttribute('src')).toBe('x')
  expect(html).not.toContain('onerror')
  expect(container.querySelector('script')).toBeNull()
})
