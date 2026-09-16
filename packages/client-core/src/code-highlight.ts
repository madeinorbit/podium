/**
 * Shared synchronous highlight.js 11.11.1 token contract. No DOM, Worker, HTML,
 * Promise, or platform scheduling API is exposed; callers choose where to run it.
 *
 * Scopes use highlight.js semantic names without the hljs- prefix. Dotted names
 * stay dotted (title.function, not a web CSS class encoding). The emitted set is:
 * attr, attribute, built_in, bullet, char.escape, code, comment, doctag, emphasis,
 * function, keyword, link, literal, meta, name, number, operator, params, property,
 * punctuation, quote, regexp, section, string, strong, subst, symbol, tag,
 * template-variable, title, title.class, title.class.inherited, title.function,
 * title.function.invoke, type, variable, variable.constant, variable.language.
 * null means unstyled source. Sublanguage wrappers are not styling scopes.
 * Nested scopes select the innermost style; concatenating token text exactly
 * reconstructs the input. Tokens and their list are immutable.
 *
 * The operator's 2026-09-16 measurement on this box was about 1 ms per 10-line
 * TypeScript block (not a mobile latency guarantee). Cold grammar registration,
 * block size, and auto-detection across all ten grammars can cost more. Registration
 * is lazy; results use a bounded content memo. Mobile callers should budget this
 * synchronous work; web callers should run it in their compute worker.
 */
import core from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import rust from 'highlight.js/lib/languages/rust'
import markdown from 'highlight.js/lib/languages/markdown'
import xml from 'highlight.js/lib/languages/xml'

/** Platform-neutral leaves; null means unstyled source text. Never HTML. */
export interface CodeToken { readonly scope: string | null; readonly text: string }
const grammars = { typescript, javascript, bash, json, python, sql, yaml, rust, markdown, xml }
type Language = keyof typeof grammars
const aliases: Record<string, Language | 'plain'> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', jsonc: 'json',
  py: 'python', yml: 'yaml', rs: 'rust', md: 'markdown', html: 'xml', htm: 'xml',
  text: 'plain', txt: 'plain', plaintext: 'plain', plain: 'plain',
}
const hljs = core.newInstance()
const loaded = new Set<Language>()
function register(language: Language): void {
  if (loaded.has(language)) return
  // JSX/TSX use the XML sublanguage.
  if (language === 'typescript' || language === 'javascript') register('xml')
  hljs.registerLanguage(language, grammars[language])
  loaded.add(language)
}
const scopes = new Set(
  'attr attribute built_in bullet char.escape code comment doctag emphasis function keyword link literal meta name number operator params property punctuation quote regexp section string strong subst symbol tag template-variable title title.class title.class.inherited title.function title.function.invoke type variable variable.constant variable.language'.split(' '),
)

interface Tree { scope?: string; children: Array<string | Tree> }
function flatten(tree: Tree, tokens: CodeToken[], inherited: string | null = null): void {
  const scope = tree.scope?.startsWith('language:')
    ? null
    : tree.scope && scopes.has(tree.scope) ? tree.scope : inherited
  for (const child of tree.children) {
    if (typeof child !== 'string') { flatten(child, tokens, scope); continue }
    if (!child) continue
    const previous = tokens.at(-1)
    if (previous?.scope === scope) tokens[tokens.length - 1] = { scope, text: previous.text + child }
    else tokens.push({ scope, text: child })
  }
}
function hash(value: string): number {
  let result = 2166136261
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619)
  return result >>> 0
}
const memo = new Map<number, { source: string; tokens: readonly CodeToken[] }>()
/** Stable UI identity belongs to the parsed block, never its changing contents. */
export function codeBlockIdentity(itemId: string, ordinal: number): string {
  return JSON.stringify([itemId, ordinal])
}
/** Synchronous on every platform. Grammar registration and memoization are realm-local. */
export function highlightCode(text: string, langHint?: string): readonly CodeToken[] {
  const hint = (langHint ?? '').trim().split(/\s+/)[0]!.toLowerCase()
  const language = (Object.hasOwn(aliases, hint) ? aliases[hint] : undefined)
    ?? (Object.hasOwn(grammars, hint) ? hint as Language : undefined)
  const source = JSON.stringify([language ?? hint, text])
  const key = hash(source)
  const cached = memo.get(key)
  if (cached?.source === source) return cached.tokens // Verify collisions, not just hashes.
  let tokens: CodeToken[] = [{ scope: null, text }]
  if (language !== 'plain' && (!hint || language)) {
    try {
      if (language) register(language)
      else for (const name of Object.keys(grammars) as Language[]) register(name)
      const result = language
        ? hljs.highlight(text, { language, ignoreIllegals: true })
        : hljs.highlightAuto(text, [...loaded])
      if (language || result.relevance >= 5) {
        const leaves: CodeToken[] = []
        // highlight.js 11's token emitter is the sole internal API used here.
        flatten((result._emitter as unknown as { rootNode: Tree }).rootNode, leaves)
        if (leaves.map(token => token.text).join('') === text) tokens = leaves
      }
    } catch { /* Malformed/unsupported input remains exact, unstyled source. */ }
  }
  const frozen = Object.freeze(tokens.map(token => Object.freeze(token)))
  // Bound retained entries and avoid retaining unusually large blocks.
  if (source.length <= 100_000) {
    if (memo.size >= 256) memo.delete(memo.keys().next().value!)
    memo.set(key, { source, tokens: frozen })
  }
  return frozen
}
