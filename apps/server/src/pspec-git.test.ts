import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSpec, saveSpec } from './pspec'
import { specBranchDiff, specBranches, specTreeAtRef } from './pspec-git'

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

describe('pspec-git', () => {
  let repo: string
  let addedId: string
  let modifiedId: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'pspec-git-'))
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'user.email', 't@example.com')
    sh(repo, 'config', 'user.name', 't')
    modifiedId = createSpec(repo, { title: 'Auth', parent: 'SP-root' }).id
    saveSpec(repo, { id: modifiedId, body: '<p>passwords only</p>' })
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'base spec')

    sh(repo, 'checkout', '-qb', 'issue/42-sso')
    saveSpec(repo, { id: modifiedId, body: '<p>passwords and SSO</p>' })
    addedId = createSpec(repo, { title: 'SSO', parent: modifiedId }).id
    saveSpec(repo, { id: addedId, body: '<p>OIDC via corp IdP</p>' })
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'sso spec changes')
    sh(repo, 'checkout', '-q', 'main')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists branches touching pspec/', async () => {
    const branches = await specBranches(repo)
    expect(branches).toHaveLength(1)
    expect(branches[0]?.branch).toBe('issue/42-sso')
    expect(branches[0]?.changedComponents).toBe(2)
  })

  it('reads the spec tree at a ref', async () => {
    const tree = await specTreeAtRef(repo, 'issue/42-sso')
    expect(tree.get(addedId)?.title).toBe('SSO')
    expect(tree.get(modifiedId)?.body).toContain('SSO')
  })

  it('diffs a branch component by component', async () => {
    const { changes } = await specBranchDiff(repo, 'issue/42-sso')
    const byId = new Map(changes.map((c) => [c.id, c]))
    const added = byId.get(addedId)
    expect(added?.changeKind).toBe('added')
    expect(added?.baseHtml).toBeNull()
    expect(added?.headHtml).toContain('OIDC')
    expect(added?.parentChain.map((p) => p.id)).toEqual(['SP-root', modifiedId])
    const modified = byId.get(modifiedId)
    expect(modified?.changeKind).toBe('modified')
    expect(modified?.baseHtml).toContain('passwords only')
    expect(modified?.headHtml).toContain('passwords and SSO')
  })

  it('returns empty for a branch with no pspec changes', async () => {
    sh(repo, 'branch', '-q', 'noop')
    const { changes } = await specBranchDiff(repo, 'noop')
    expect(changes).toEqual([])
    expect((await specBranches(repo)).map((b) => b.branch)).not.toContain('noop')
  })
})
