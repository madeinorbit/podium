import { highlightCode } from '@podium/client-core/code-highlight'
import { expect, it } from 'vitest'
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
