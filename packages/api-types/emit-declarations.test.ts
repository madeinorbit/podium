import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { emitCodeDeclarations } from './emit-declarations'

function fixture(body: (root: string, options: ts.CompilerOptions) => void) {
  const root = mkdtempSync(join(tmpdir(), 'podium-api-declarations-'))
  try {
    body(root, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      esModuleInterop: true,
      declaration: true,
      emitDeclarationOnly: true,
      noCheck: true,
      types: [],
      rootDir: root,
      outDir: join(root, 'out'),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('API declaration emission with release policy JSON', () => {
  it('keeps the public release-origin declarations independent of the JSON asset', () =>
    fixture((root, options) => {
      for (const name of ['release-origins.ts', 'release-origins.json']) {
        writeFileSync(
          join(root, name),
          readFileSync(new URL(`../runtime/src/${name}`, import.meta.url)),
        )
      }
      emitCodeDeclarations(ts.createProgram([join(root, 'release-origins.ts')], options))
      const declarations = readFileSync(join(root, 'out/release-origins.d.ts'), 'utf8')
      expect(declarations).toContain('interface ReleaseOrigin')
      expect(declarations).not.toContain('release-origins.json')
    }))

  it('emits code declarations when a JSON dependency has no declaration output', () =>
    fixture((root, options) => {
      writeFileSync(join(root, 'policy.json'), '{"origin":"https://releases.example/"}')
      writeFileSync(
        join(root, 'entry.ts'),
        "import policy from './policy.json'; export const origin = policy.origin",
      )
      const program = ts.createProgram([join(root, 'entry.ts')], options)
      // This is the compiler behavior that used to reject the entire API build.
      const aggregate = program.emit()
      expect(aggregate.emitSkipped).toBe(true)
      expect(aggregate.diagnostics).toEqual([])
      expect(() => emitCodeDeclarations(program)).not.toThrow()
      expect(readFileSync(join(root, 'out/entry.d.ts'), 'utf8')).toContain(
        'export declare const origin: string',
      )
    }))

  it('continues to refuse real declaration failures', () =>
    fixture((root, options) => {
      writeFileSync(join(root, 'entry.ts'), "export const value: number = 'wrong'")
      const program = ts.createProgram([join(root, 'entry.ts')], {
        ...options,
        noCheck: false,
        noEmitOnError: true,
      })
      expect(() => emitCodeDeclarations(program)).toThrow('API declaration emission failed')
    }))
})
