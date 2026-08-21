import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseProposalFacts } from './release-proposal'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function commit(root: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function repository(): { root: string; base: string; migration: string } {
  const root = mkdtempSync(join(tmpdir(), 'podium-proposal-range-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'proposal@test.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Proposal Test'], { cwd: root })
  const migration = join(
    root,
    'apps/server/src/migrations/drizzle/20260821090000_existing/migration.sql',
  )
  mkdirSync(join(migration, '..'), { recursive: true })
  writeFileSync(migration, 'CREATE TABLE existing(id TEXT);\n')
  return { root, base: commit(root, 'base migration'), migration }
}

describe('releaseProposalFacts', () => {
  it('uses the published-to-HEAD range and flags only added migration definitions', async () => {
    const calls: string[][] = []
    const facts = await releaseProposalFacts({
      root: '/repo',
      headSha: 'bbbbbbb',
      sinceSha: 'aaaaaaa',
      git: async (args) => {
        calls.push([...args])
        if (args[0] === 'rev-parse') return 'feature/branch-release\n'
        if (args[0] === 'log') return 'bbbbbbbbbbbb\0Add branch release\0'
        return (
          'apps/server/src/migrations/drizzle/20260821110000_branch_release/migration.sql\0' +
          'apps/server/src/migrations/drizzle/20260821110000_branch_release/meta.json\0'
        )
      },
    })

    expect(facts).toEqual({
      branch: 'feature/branch-release',
      commits: [{ sha: 'bbbbbbb', summary: 'Add branch release' }],
      addedMigrations: ['20260821110000_branch_release'],
    })
    expect(calls).toContainEqual([
      'diff',
      '--diff-filter=A',
      '--name-only',
      '-z',
      'aaaaaaa',
      'bbbbbbb',
      '--',
      'apps/server/src/migrations/drizzle',
    ])
  })

  it('names detached HEAD and leaves a migration-free branch unflagged', async () => {
    const facts = await releaseProposalFacts({
      root: '/repo',
      headSha: 'ccccccc',
      sinceSha: 'aaaaaaa',
      git: async (args) => {
        if (args[0] === 'rev-parse') return 'HEAD\n'
        if (args[0] === 'log') return 'cccccccccccc\0Try old branch\0'
        return ''
      },
    })
    expect(facts.branch).toBe('detached@ccccccc')
    expect(facts.addedMigrations).toEqual([])
  })

  it('does not flag a migration added and then reverted inside the proposal range', async () => {
    const { root, base } = repository()
    const added = join(
      root,
      'apps/server/src/migrations/drizzle/20260821110000_reverted/migration.sql',
    )
    mkdirSync(join(added, '..'), { recursive: true })
    writeFileSync(added, 'CREATE TABLE reverted(id TEXT);\n')
    commit(root, 'add migration temporarily')
    rmSync(join(added, '..'), { recursive: true })
    const headSha = commit(root, 'revert temporary migration')

    const facts = await releaseProposalFacts({ root, sinceSha: base, headSha })
    expect(facts.addedMigrations).toEqual([])
  })

  it('does not flag a proposal that only modifies an existing migration file', async () => {
    const { root, base, migration } = repository()
    writeFileSync(migration, 'CREATE TABLE existing(id TEXT, name TEXT);\n')
    const headSha = commit(root, 'touch existing migration')

    const facts = await releaseProposalFacts({ root, sinceSha: base, headSha })
    expect(facts.addedMigrations).toEqual([])
  })
})
