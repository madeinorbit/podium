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
