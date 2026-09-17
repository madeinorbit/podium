import { adaptiveColor } from './platform-colors'
import { color } from './theme'

// High-contrast inks deepen/lighten each hue and meet 7:1 on the app grounds
// plus conservative UIKit surface bounds (#e5e5ea light, #2c2c2e dark).
// Normal colours remain web-parity values. See platform-colors.test.ts.
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
  highContrastLight: {
    ink: '#2d2b26',
    comment: '#4a4943',
    punct: '#4b4945',
    operator: '#4b4943',
    keyword: '#5a28aa',
    string: '#0e5438',
    number: '#654200',
    function: '#173ead',
    type: '#095060',
    property: '#1d4186',
    tag: '#77361e',
  },
  highContrastDark: {
    ink: '#dddfe5',
    comment: '#b6bbc4',
    punct: '#b5bac3',
    operator: '#b9beca',
    keyword: '#c9aef9',
    string: '#a5d9b9',
    number: '#edc08d',
    function: '#99c0ff',
    type: '#8cd9d9',
    property: '#b9d3f7',
    tag: '#f3a995',
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
  return token
    ? adaptiveColor(
        syntaxPalette.light[token],
        syntaxPalette.dark[token],
        syntaxPalette.highContrastLight[token],
        syntaxPalette.highContrastDark[token],
      )
    : color.body
}

// Whole prose spans have independent semantics from parsed syntax roles.
export const prosePalette = {
  light: { 'code-inline': '#87356b' },
  dark: { 'code-inline': '#e0a2cb' },
  highContrastLight: { 'code-inline': '#6c2a56' },
  highContrastDark: { 'code-inline': '#e6b5d5' },
} as const

export function proseColor(token: keyof typeof prosePalette.light): string {
  return adaptiveColor(
    prosePalette.light[token],
    prosePalette.dark[token],
    prosePalette.highContrastLight[token],
    prosePalette.highContrastDark[token],
  )
}
