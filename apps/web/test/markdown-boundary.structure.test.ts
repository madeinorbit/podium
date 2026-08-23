import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
  type ExportDeclaration,
  type ImportDeclaration,
} from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(import.meta.dirname, '../src')
const entry = join(sourceRoot, 'app/main.tsx')

const forbiddenPackages = [
  'dompurify',
  'highlight.js',
  'lowlight',
  'marked',
  'prismjs',
  'react-markdown',
  'react-syntax-highlighter',
  'refractor',
  'rehype-sanitize',
  'remark-gfm',
  'shiki',
  '@lezer/highlight',
  '@shikijs',
] as const

function importHasRuntimeValue(statement: ImportDeclaration): boolean {
  const clause = statement.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (isNamespaceImport(bindings)) return true
  return isNamedImports(bindings) && bindings.elements.some((element) => !element.isTypeOnly)
}

function exportHasRuntimeValue(statement: ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false
  const clause = statement.exportClause
  if (!clause) return true
  if (!isNamedExports(clause)) return true
  return clause.elements.some((element) => !element.isTypeOnly)
}

function localModule(importer: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(sourceRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(importer), specifier)
      : null
  if (!base) return null

  const candidates = /\.[cm]?[jt]sx?$/.test(base)
    ? [base]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
      ]
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile()
      } catch {
        return false
      }
    }) ?? null
  )
}

function forbiddenPackage(specifier: string): string | null {
  return (
    forbiddenPackages.find(
      (packageName) =>
        specifier === packageName || specifier.startsWith(`${packageName}/`),
    ) ?? null
  )
}

function eagerSourceGraph(root: string): {
  files: Set<string>
  forbiddenImports: string[]
} {
  const files = new Set<string>()
  const forbiddenImports: string[] = []
  const pending = [root]

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || files.has(file)) continue
    files.add(file)

    const source = readFileSync(file, 'utf8')
    const parsed = createSourceFile(
      file,
      source,
      ScriptTarget.Latest,
      false,
      file.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS,
    )

    for (const statement of parsed.statements) {
      const runtimeImport =
        isImportDeclaration(statement) && importHasRuntimeValue(statement)
          ? statement.moduleSpecifier
          : isExportDeclaration(statement) &&
              exportHasRuntimeValue(statement) &&
              statement.moduleSpecifier
            ? statement.moduleSpecifier
            : null
      if (!runtimeImport || !isStringLiteral(runtimeImport)) continue

      const specifier = runtimeImport.text
      const forbidden = forbiddenPackage(specifier)
      if (forbidden) {
        forbiddenImports.push(`${relative(sourceRoot, file)} -> ${specifier}`)
        continue
      }
      const local = localModule(file, specifier)
      if (local && !files.has(local)) pending.push(local)
    }
  }

  return { files, forbiddenImports }
}

describe('Markdown loading boundary', () => {
  it('keeps parser, sanitizer, and syntax highlighting out of the eager web graph', () => {
    const graph = eagerSourceGraph(entry)
    const eagerFiles = [...graph.files].map((file) => relative(sourceRoot, file)).sort()

    expect(graph.forbiddenImports).toEqual([])
    expect(eagerFiles).not.toContain('lib/markdown.ts')
    expect(eagerFiles).not.toContain('lib/markdown-renderer.ts')
    expect(eagerFiles).not.toContain('features/chat/ChatBlockView.tsx')
    expect(eagerFiles).not.toContain('features/chat/TranscriptFeed.tsx')
  })

  it('uses a literal dynamic import for the transcript renderer', () => {
    const boundary = readFileSync(
      join(sourceRoot, 'features/chat/TranscriptFeedBoundary.tsx'),
      'utf8',
    )

    expect(boundary).toMatch(
      /lazy\(\(\) =>\s*import\(['"]\.\/TranscriptFeed['"]\)\.then\(\(module\) =>/,
    )
  })
})
