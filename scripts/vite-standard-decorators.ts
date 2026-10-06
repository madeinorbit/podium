/** Vite 8 compiles TypeScript with Oxc, which lowers only legacy
 * (experimentalDecorators) decorators and leaves standard ones in its output,
 * where neither browsers nor JavaScriptCore can parse them ("Invalid character
 * '@'"). This pre-transform lowers standard decorators (`@lazy get x()` from
 * @podium/mobx-helpers) with esbuild, only in the files that use them; every
 * other file stays on Oxc untouched. Metro gets the same through
 * apps/mobile/babel.config.js; Bun compiles them natively. */
import { transform } from 'esbuild'

// A decorator starts a line (class members are written one per line) and is
// followed by a class member: a modifier keyword, or a name and then `(`, `:`,
// `=`, `;`, `!`, `?` or `<`. JSDoc tags follow a `*`; CSS at-rules in template
// strings (`@media (...) {`, `@keyframes fade-in {`) are followed by neither.
// A false match only costs an equivalent esbuild compile of that file.
const DECORATOR = /^[ \t]*@[A-Za-z_$][\w$.]*(?:\(.*\))?\s+(?:(?:static|accessor|get|set|async|override|readonly|public|private|protected|declare|abstract|export|class)\b|[A-Za-z_$#][\w$]*\s*[(:=;!?<])/m
const TYPESCRIPT = /\.[cm]?tsx?$/

export function usesDecorators(code: string, id: string): boolean {
  const file = id.replace(/\?.*$/s, '')
  return TYPESCRIPT.test(file) && !file.includes('/node_modules/') && DECORATOR.test(code)
}

export async function lowerDecorators(code: string, id: string): Promise<{ code: string; map: string }> {
  const file = id.replace(/\?.*$/s, '')
  const out = await transform(code, {
    loader: file.endsWith('x') ? 'tsx' : 'ts',
    sourcefile: file,
    sourcemap: 'external',
    format: 'esm',
    // Lower decorators and nothing else; JSX stays for the React transform.
    target: 'esnext',
    supported: { decorators: false },
    jsx: 'preserve',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true, verbatimModuleSyntax: true } },
  })
  return { code: out.code, map: out.map }
}

export function standardDecorators() {
  return {
    name: 'podium-standard-decorators',
    enforce: 'pre' as const,
    async transform(code: string, id: string) {
      if (usesDecorators(code, id)) return lowerDecorators(code, id)
    },
  }
}
