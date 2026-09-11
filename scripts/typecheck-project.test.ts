import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compilerArgs, resolveCompiler, turboRefusal } from './typecheck-project'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeRoot(version: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-project-'))
  roots.push(root)
  if (version !== null) {
    mkdirSync(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ version }),
    )
  }
  return root
}

describe('typecheck-project', () => {
  it('runs only under turbo, and names the sanctioned entry when refused', () => {
    expect(turboRefusal({ TURBO_HASH: 'abc' })).toBeNull()
    const refusal = turboRefusal({})
    expect(refusal).toContain('bun run typecheck -- --filter <package>')
    expect(refusal).toContain('validation slot')
  })

  it('resolves the root TypeScript 7 binary by path and refuses anything else', () => {
    const seven = resolveCompiler(fakeRoot('7.0.2'))
    expect(seven.error).toBeNull()
    expect(seven.compiler?.bin).toMatch(/node_modules\/typescript\/bin\/tsc$/)

    expect(resolveCompiler(fakeRoot('6.0.3')).error).toContain('not the 7.x Go compiler')
    expect(resolveCompiler(fakeRoot(null)).error).toContain('setup:worktree')
  })

  it('forces --noEmit and --incremental ahead of whatever the manifest passes', () => {
    expect(compilerArgs([])).toEqual(['--noEmit', '--incremental'])
    expect(compilerArgs(['-p', 'tsconfig.node.json'])).toEqual([
      '--noEmit',
      '--incremental',
      '-p',
      'tsconfig.node.json',
    ])
    expect(compilerArgs(['--incremental', '--noEmit'])).toEqual(['--noEmit', '--incremental'])
  })
})
