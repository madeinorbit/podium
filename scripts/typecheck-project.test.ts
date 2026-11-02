import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkerArgs, resolveChecker, turboRefusal } from './typecheck-project'

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

  const bun7 = { bin: '/pinned/bun', typescript: '7.0.2' }

  it("runs the running Bun's own checker when it matches the editor's TypeScript", () => {
    const ok = resolveChecker(fakeRoot('7.0.2'), bun7)
    expect(ok.error).toBeNull()
    expect(ok.checker).toEqual({ bin: '/pinned/bun', version: '7.0.2' })
  })

  it('refuses a Bun without a TypeScript 7 checker and names the pin', () => {
    for (const typescript of [undefined, '6.0.3']) {
      const refused = resolveChecker(fakeRoot('7.0.2'), { bin: '/old/bun', typescript }).error
      expect(refused).toContain('no TypeScript 7 checker')
      expect(refused).toContain('mise install bun')
    }
  })

  it("refuses when the editor's TypeScript is not the version bun check implements", () => {
    const drift = resolveChecker(fakeRoot('7.0.3'), bun7).error
    expect(drift).toContain('implements TypeScript 7.0.2')
    expect(drift).toContain('is 7.0.3')
    // setup:worktree cannot repair a stale install: a frozen reconcile never prunes the
    // dangling .bin/tsserver an old install leaves, and that is what the topology census refuses.
    const stale = resolveChecker(fakeRoot('6.0.3'), bun7).error
    expect(stale).toContain('deps:repair')
    expect(stale).not.toMatch(/run `bun run setup:worktree`/)
    expect(resolveChecker(fakeRoot(null), bun7).error).toContain('deps:repair')
  })

  it('runs `bun check --no-script` ahead of whatever the manifest passes', () => {
    expect(checkerArgs([])).toEqual(['check', '--no-script'])
    expect(checkerArgs(['-p', 'tsconfig.node.json'])).toEqual([
      'check',
      '--no-script',
      '-p',
      'tsconfig.node.json',
    ])
    // the tsc-era flags are dropped: bun check never emits and keeps no incremental state
    expect(checkerArgs(['--incremental', '--noEmit'])).toEqual(['check', '--no-script'])
  })
})
