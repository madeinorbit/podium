import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'

// Load only the archived proc function: importing a drive runs paid agents.
// The AST keeps this test on the actual driver code without executing its entrypoint.
function procFromDriver(path: string, present: boolean) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'proc')
  if (!declaration) throw new Error(`proc missing from ${path}`)
  const javascript = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const readlink = vi.fn((path: string) => path.endsWith('/exe') ? '/bin/agent' : '/work')
  const read = (path: string) => path.endsWith('/stat') ? '123 (agent) S 1' : ''
  const proc = new Function('readFileSync', 'existsSync', 'readlink', 'Bun',
    `${javascript}; return proc;`)(read, () => present, readlink,
      { file: () => ({ exists: async () => present }) }) as (pid: number) => { exe: string } | undefined
  return { proc, readlink }
}

for (const issue of ['pod-2987', 'pod-3028']) {
  describe(`${issue} archived process evidence`, () => {
    it('does not resolve a missing executable link', () => {
      const { proc, readlink } = procFromDriver(`docs/evidence/${issue}/drive.ts`, false)
      expect(proc(123)?.exe).toBe('')
      expect(readlink).not.toHaveBeenCalledWith('/proc/123/exe')
    })
    it('records an existing executable link', () => {
      const { proc, readlink } = procFromDriver(`docs/evidence/${issue}/drive.ts`, true)
      expect(proc(123)?.exe).toBe('/bin/agent')
      expect(readlink).toHaveBeenCalledWith('/proc/123/exe')
    })
  })
}
