import { adaptiveColor } from './platform-colors'
import { color } from './theme'

// Mirrors apps/web/src/index.css --syntax-*; parity is checked in syntax.test.tsx.
export const syntaxPalette = {
  light: {
    ink: '#38362f',
    comment: '#6f6d64',
    punct: '#8a8880',
    operator: '#5f5d55',
    keyword: '#7132d4',
    string: '#12704a',
    number: '#8a5a00',
    function: '#1d4ed8',
    type: '#0c6f86',
    property: '#2451a8',
    tag: '#ad4e2b',
  },
  dark: {
    ink: '#d5d7de',
    comment: '#838b9b',
    punct: '#8a91a0',
    operator: '#a7aebd',
    keyword: '#bb9af7',
    string: '#8fd0a8',
    number: '#e8b071',
    function: '#7fb0ff',
    type: '#6fcfd0',
    property: '#a8c8f5',
    tag: '#f0937a',
  },
} as const

/** All shared scopes, including intentional body-ink fallbacks.
 * Mirrors the chat/tool rules in apps/web/src/index.css (POD-4079). */
export const syntaxScopeToken = {
  attr: 'property',
  attribute: 'property',
  built_in: 'type',
  bullet: 'tag',
  'char.escape': null,
  code: null,
  comment: 'comment',
  doctag: null,
  emphasis: null,
  function: null,
  keyword: 'keyword',
  link: null,
  literal: 'number',
  meta: null,
  name: 'tag',
  number: 'number',
  operator: 'operator',
  params: 'property',
  property: 'property',
  punctuation: 'punct',
  quote: 'comment',
  regexp: 'string',
  section: null,
  string: 'string',
  strong: null,
  subst: null,
  symbol: null,
  tag: 'tag',
  'template-variable': 'property',
  title: 'function',
  'title.class': 'type',
  'title.class.inherited': 'type',
  'title.function': 'function',
  'title.function.invoke': 'function',
  type: 'type',
  variable: 'property',
  'variable.constant': 'property',
  'variable.language': 'property',
} as const satisfies Record<string, keyof typeof syntaxPalette.dark | null>

export function syntaxColor(scope: string | null): string {
  const token =
    scope !== null && Object.hasOwn(syntaxScopeToken, scope)
      ? syntaxScopeToken[scope as keyof typeof syntaxScopeToken]
      : null
  return token ? adaptiveColor(syntaxPalette.light[token], syntaxPalette.dark[token]) : color.body
}

// Whole prose spans have independent semantics from parsed syntax roles.
export const prosePalette = {
  light: { 'code-inline': '#0c6f86', 'text-strong': '#1d1c19', foreground: '#38362f' },
  dark: { 'code-inline': '#6fcfd0', 'text-strong': '#f2f3f5', foreground: '#d7dae0' },
} as const

export function proseColor(token: keyof typeof prosePalette.light): string {
  return adaptiveColor(prosePalette.light[token], prosePalette.dark[token])
}
