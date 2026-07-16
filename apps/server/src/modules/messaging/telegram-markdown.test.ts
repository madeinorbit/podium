import { describe, expect, it } from 'vitest'
import {
  escapeTelegramMarkdownV2,
  formatTelegramMarkdown,
  isTelegramMarkdownParseError,
  stripTelegramMarkdownV2,
  wrapMarkdownTables,
} from './telegram-markdown'

describe('escapeTelegramMarkdownV2', () => {
  it('escapes special characters', () => {
    expect(escapeTelegramMarkdownV2('Hello (world)!')).toBe('Hello \\(world\\)\\!')
    expect(escapeTelegramMarkdownV2('v2.0')).toBe('v2\\.0')
    expect(escapeTelegramMarkdownV2('a\\b')).toBe('a\\\\b')
  })

  it('passes through plain text', () => {
    expect(escapeTelegramMarkdownV2('hello world 123')).toBe('hello world 123')
    expect(escapeTelegramMarkdownV2('')).toBe('')
  })
})

describe('stripTelegramMarkdownV2', () => {
  it('removes escapes and formatting markers', () => {
    expect(stripTelegramMarkdownV2('hello\\.world\\!')).toBe('hello.world!')
    expect(stripTelegramMarkdownV2('*bold* and _italic_')).toBe('bold and italic')
    expect(stripTelegramMarkdownV2('~struck~')).toBe('struck')
    expect(stripTelegramMarkdownV2('||hidden||')).toBe('hidden')
  })

  it('preserves snake_case identifiers', () => {
    expect(stripTelegramMarkdownV2('my_variable_name')).toBe('my_variable_name')
  })
})

describe('wrapMarkdownTables', () => {
  it('rewrites GFM tables into row groups', () => {
    const text = [
      'Scores:',
      '',
      '| Player | Score |',
      '|--------|-------|',
      '| Alice  | 150   |',
      '| Bob    | 120   |',
      '',
      'End.',
    ].join('\n')
    const out = wrapMarkdownTables(text)
    expect(out).toContain('**Alice**')
    expect(out).not.toContain('• Player: Alice')
    expect(out).toContain('• Score: 150')
    expect(out).toContain('**Bob**')
    expect(out).toContain('• Score: 120')
    expect(out).toContain('**Alice**\n• Score: 150')
    expect(out).toContain('• Score: 150\n\n**Bob**')
    expect(out.startsWith('Scores:')).toBe(true)
    expect(out.endsWith('End.')).toBe(true)
  })

  it('leaves prose pipes and horizontal rules alone', () => {
    expect(wrapMarkdownTables('Use the | pipe operator to chain commands.')).toBe(
      'Use the | pipe operator to chain commands.',
    )
    expect(wrapMarkdownTables('Section A\n\n---\n\nSection B')).toBe(
      'Section A\n\n---\n\nSection B',
    )
  })

  it('does not rewrite tables inside fenced code blocks', () => {
    const text = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
    expect(wrapMarkdownTables(text)).toBe(text)
  })

  it('uses single newlines within row groups', () => {
    const text = [
      '| Play | Capital | Build | $/day | Risk |',
      '|---|---|---|---|---|',
      '| A. Copy Hands | $5-10k | 2 wk | $30-70 | Low |',
      '| B. NO-sweeper | $50-100k | 3 wk | $300-1000 | Med |',
    ].join('\n')
    const out = wrapMarkdownTables(text)
    expect(out).not.toContain('\n\n• ')
    const groups = out.split('\n\n').filter((g) => g.trim())
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      expect(group.split('\n')).toHaveLength(5)
    }
  })
})

describe('formatTelegramMarkdown', () => {
  it('converts bold, italic, headers, and links', () => {
    expect(formatTelegramMarkdown('This is **bold** text')).toContain('*bold*')
    expect(formatTelegramMarkdown('This is *italic* text')).toContain('_italic_')
    expect(formatTelegramMarkdown('# Title')).toContain('*Title*')
    expect(formatTelegramMarkdown('[Click](https://example.com)')).toContain(
      '[Click](https://example.com)',
    )
  })

  it('preserves fenced and inline code', () => {
    const fenced = formatTelegramMarkdown('Before\n```python\nprint("hi")\n```\nAfter')
    expect(fenced).toContain('```python\nprint("hi")\n```')
    expect(fenced).toContain('After')

    const inline = formatTelegramMarkdown('Use `my_var` here')
    expect(inline).toContain('`my_var`')
  })

  it('escapes specials in plain text', () => {
    const result = formatTelegramMarkdown('Price is $5.00!')
    expect(result).toContain('\\.')
    expect(result).toContain('\\!')
  })

  it('does not let italic span newlines', () => {
    const text = '* Item one\n* Item two'
    const result = formatTelegramMarkdown(text)
    expect(result).toContain('Item one')
    expect(result).toContain('Item two')
    expect(result).not.toContain('_across\nlines_')
  })

  it('converts tables end-to-end without pipe escapes', () => {
    const text = [
      'Data:',
      '',
      '| Col1 | Col2 |',
      '|------|------|',
      '| A    | B    |',
    ].join('\n')
    const out = formatTelegramMarkdown(text)
    expect(out).toContain('*A*')
    expect(out).not.toContain('• Col1: A')
    expect(out).toContain('• Col2: B')
    expect(out).not.toContain('```')
    expect(out).not.toContain('\\|')
  })

  it('does not leak placeholder tokens', () => {
    const text = '# Header\n**bold1** *italic1* `code1`\n[link](https://url.com)'
    const result = formatTelegramMarkdown(text)
    expect(result).not.toContain('\x00')
    expect(result).toContain('Header')
    expect(result).toContain('url.com')
  })
})

describe('isTelegramMarkdownParseError', () => {
  it('detects parse failures', () => {
    const err = Object.assign(new Error("Bad Request: can't parse entities"), { status: 400 })
    expect(isTelegramMarkdownParseError(err)).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isTelegramMarkdownParseError(new Error('thread not found'))).toBe(false)
    expect(isTelegramMarkdownParseError(new Error('flood control'))).toBe(false)
  })
})