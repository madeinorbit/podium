import { describe, expect, it } from 'vitest'
import { codeBlockIdentity, highlightCode } from './code-highlight'

describe('shared code tokens', () => {
  it.each([
    'ts',
    'tsx',
    'js',
    'sh',
    'jsonc',
    'py',
    'sql',
    'yml',
    'rs',
    'md',
    'html',
  ])('preserves exact source for %s', (lang) => {
    const source = 'const x = "<script>&雪";\n\n'
    expect(
      highlightCode(source, lang)
        .map((token) => token.text)
        .join(''),
    ).toBe(source)
  })
  it('normalizes aliases and memoizes content independently of identity', () => {
    const source = 'const count: number = 42'
    const tokens = highlightCode(source, 'ts extra')
    expect(tokens).toBe(highlightCode(source, 'typescript'))
    expect(tokens.some((token) => token.scope === 'keyword')).toBe(true)
    expect(codeBlockIdentity('item', 0)).not.toBe(codeBlockIdentity('item', 1))
    expect(codeBlockIdentity('other', 0)).not.toBe(codeBlockIdentity('item', 0))
  })
  it('leaves unknown labels and low-confidence prose plain', () => {
    for (const hint of ['unknown', 'plaintext', undefined]) {
      expect(highlightCode('hello world', hint)).toEqual([{ scope: null, text: 'hello world' }])
    }
  })
  it('detects a strong unlabelled code sample', () => {
    expect(
      highlightCode('def greet(name):\n    # greeting\n    print("hello")\n    return None').some(
        (token) => token.scope,
      ),
    ).toBe(true)
  })
  it('returns synchronous semantic scopes with dotted names intact', () => {
    const tokens = highlightCode(
      'class Child extends Parent {}\nfunction greet() { return true }',
      'ts',
    )
    expect(Array.isArray(tokens)).toBe(true)
    expect(tokens).toContainEqual({ scope: 'title.class', text: 'Child' })
    expect(tokens).toContainEqual({ scope: 'title.class.inherited', text: 'Parent' })
    expect(tokens).toContainEqual({ scope: 'title.function', text: 'greet' })
    expect(tokens).toContainEqual({ scope: 'literal', text: 'true' })
  })
  it('does not leak sublanguage wrappers into the theme vocabulary', () => {
    const source = 'const view = <div title="hello">world</div>'
    const tokens = highlightCode(source, 'tsx')
    expect(tokens.map((token) => token.text).join('')).toBe(source)
    expect(tokens).toContainEqual({ scope: 'name', text: 'div' })
    expect(tokens).toContainEqual({ scope: null, text: 'world' })
    expect(tokens.some((token) => token.scope?.startsWith('language:'))).toBe(false)
  })
  it('returns partial tokens for illegal input under an explicit grammar', () => {
    const source = '{"key": true, broken}'
    const tokens = highlightCode(source, 'json')
    expect(tokens.map((token) => token.text).join('')).toBe(source)
    expect(tokens.some((token) => token.scope)).toBe(true)
  })
})
