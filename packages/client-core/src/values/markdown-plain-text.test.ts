import { expect, it } from 'vitest'
import { markdownPlainText } from './markdown-plain-text'

it.each(['<br>', '<br/>', '<br />', '<BR>'])('preserves rendered %s line breaks', (tag) => {
  expect(markdownPlainText(`first${tag}second`)).toBe('first\nsecond')
})

it('renders headings, emphasis, links, lists and quotes as readable text', () => {
  expect(
    markdownPlainText(
      '# **Ready**\n\nOpen `chat.ts` and [the report](https://example.com).\n\n- **First**\n- Second\n\n> A quote',
    ),
  ).toBe('Ready\n\nOpen chat.ts and the report.\n\n• First\n• Second\n\nA quote')
})

it('preserves source bytes inside code and decodes prose entities and escapes', () => {
  expect(
    markdownPlainText('A &amp; B \\*literal\\*\n\n```sh\necho "**keep** &amp;"\n  next\n```'),
  ).toBe('A & B *literal*\n\necho "**keep** &amp;"\n  next')
})

it('keeps table cells and task states without fences or raw HTML', () => {
  expect(
    markdownPlainText(
      '| Name | State |\n|---|---|\n| **Chat** | `done` |\n\n- [x] Selected\n\n<script>hidden()</script>',
    ),
  ).toBe('Name\tState\nChat\tdone\n\n☑ Selected')
})
