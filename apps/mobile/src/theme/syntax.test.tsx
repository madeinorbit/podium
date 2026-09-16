import { readFileSync } from 'node:fs'
import { highlightCode } from '@podium/client-core/code-highlight'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HighlightedCode } from '../components/HighlightedCode'
import { syntaxPalette, syntaxScopeToken } from './syntax'
import { color } from './theme'

let mode: 'light' | 'dark' = 'dark'
vi.mock('./platform-colors', async (original) => ({
  ...(await original<object>()),
  adaptiveColor: (light: string, dark: string) => (mode === 'light' ? light : dark),
}))
afterEach(cleanup)

const web = readFileSync(new URL('../../../web/src/index.css', import.meta.url), 'utf8')
const webScopes = new Map<string, string>()
for (const [, selectors, token] of web.matchAll(/([^{}]+)\{\s*color: var\(--syntax-([\w-]+)\);\s*\}/g)) {
  for (const [, scope] of selectors.matchAll(/\.hljs-([\w-]+)/g)) webScopes.set(scope, token)
}

function normalized(ink: string) {
  const el = document.createElement('span')
  el.style.color = ink
  return el.style.color
}

it('matches the web scope rules and both web palettes', () => {
  expect(webScopes.size).toBeGreaterThan(20)
  for (const [scope, token] of Object.entries(syntaxScopeToken)) {
    expect(token, scope).toBe(webScopes.get(scope.replaceAll('.', '-')) ?? null)
  }
  for (const [token, light] of Object.entries(syntaxPalette.light)) {
    const values = [...web.matchAll(new RegExp(`--syntax-${token}: (#[0-9a-f]+);`, 'g'))]
    expect(values.map((match) => match[1])).toEqual([light, syntaxPalette.dark[token as keyof typeof syntaxPalette.dark]])
  }
})

const cases = [
  ['typescript', 'class Store { async load(id: string) { return fetch(`/${id}`) } }'],
  ['bash', 'echo "$HOME" && printf "%s" 42'],
  ['json', '{"name": true, "count": 42}'],
  ['python', 'def greet(name):\n  # greeting\n  print("hello", name)'],
  ['sql', 'SELECT name FROM users WHERE id = 42;'],
  ['yaml', 'name: podium\nitems:\n  - first'],
  ['rust', 'fn main() { let value: i32 = 42; println!("hello"); }'],
  ['markdown', '# Heading\n- **bold** and *emphasis*'],
  ['xml', '<div class="hello">world</div>'],
  ['javascript', 'const add = (a, b) => a + b;'],
] as const

describe.each(['light', 'dark'] as const)('%s native token leaves', (appearance) => {
  it('renders real shared output with exact text and web colours', () => {
    mode = appearance
    for (const [language, source] of cases) {
      const tokens = highlightCode(source, language)
      expect(tokens.some((token) => token.scope !== null), language).toBe(true)
      const { container, unmount } = render(<HighlightedCode tokens={tokens} />)
      expect(container.textContent).toBe(source)
      expect(container.children).toHaveLength(tokens.length)
      tokens.forEach((token, index) => {
        const key = token.scope ? webScopes.get(token.scope.replaceAll('.', '-')) : undefined
        const expected = key ? syntaxPalette[appearance][key as keyof typeof syntaxPalette.dark] : color.body
        expect((container.children[index] as HTMLElement).style.color, `${language}:${token.scope}`).toBe(normalized(expected))
      })
      unmount()
    }
  })

  it('covers the complete vocabulary, body-ink scopes and hostile unknown names', () => {
    mode = appearance
    const tokens = [...Object.keys(syntaxScopeToken), 'future.scope', '__proto__', 'toString', null].map((scope) => ({ scope, text: `${scope}\n` }))
    const { container } = render(<HighlightedCode tokens={tokens} />)
    tokens.forEach(({ scope }, index) => {
      const key = scope ? webScopes.get(scope.replaceAll('.', '-')) : undefined
      const expected = key ? syntaxPalette[appearance][key as keyof typeof syntaxPalette.dark] : color.body
      expect((container.children[index] as HTMLElement).style.color, String(scope)).toBe(normalized(expected))
    })
  })
})
