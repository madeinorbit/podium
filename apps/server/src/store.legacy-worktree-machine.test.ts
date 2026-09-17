import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_WORKTREE_MIGRATION } from './store/issues'
import { openTestStore } from './test-support/open-test-store'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const dirs: string[] = []
const tmpDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-legacy-worktree-machine-'))
  dirs.push(dir)
  return join(dir, 'podium.db')
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOST = asMachineId('11111111-2222-4333-8444-555555555555')
const OTHER = asMachineId('99999999-8888-4777-8666-555555555555')

/** The machine_id column as it stands in the file, ahead of any boot. */
function machineIds(path: string): Record<string, string | null> {
  const db = openDatabase(path)
  const rows = db.prepare('SELECT id, machine_id FROM issues ORDER BY id').all() as {
    id: string
    machine_id: string | null
  }[]
  db.close()
  return Object.fromEntries(rows.map((r) => [r.id, r.machine_id]))
}

/**
 * A database in the shape a v0.1.0 build left behind: issues that own a worktree
 * but name no machine, because the build that wrote them recorded none.
 *
 * Written with raw SQL for the same reason `machine-identity.test.ts` seeds that
 * way — no code in the tree produces an unpinned worktree row any more, and a
 * fixture that went through today's writers would be pinned before the backfill
 * ever saw it, which is the vacuity this file exists to avoid.
 */
async function seedV010ShapedDb(path: string): Promise<void> {
  // Let the migration chain build the schema, then close and write behind it.
  ;await (await openTestStore(path, HOST)).close()
  const db = openDatabase(path)
  const machine = (id: string, name: string): string =>
    `INSERT OR REPLACE INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
       VALUES ('${id}', '${name}', '${name}', '${sha256(id)}', 't', 't');`
  const issue = (id: string, seq: number, worktree: string | null, pin: string | null): string =>
    `INSERT INTO issues (id, owner_user_id, created_by_actor, created_by_on_behalf_of, repo_id,
                         repo_path, seq, title, stage, default_agent,
                         created_at, updated_at, worktree_path, machine_id)
       VALUES ('${id}', '${firstAdminMemberId()}', '${firstAdminMemberId()}',
               '${firstAdminMemberId()}', 'repo:one', '/r', ${seq}, '${id}', 'backlog',
               'claude-code', 't', 't', ${worktree === null ? 'NULL' : `'${worktree}'`},
               ${pin === null ? 'NULL' : `'${pin}'`});`
  const session = (
    id: string,
    issueId: string | null,
    refIssueId: string | null,
    m: string,
  ): string =>
    `INSERT INTO sessions (id, owner_user_id, agent_kind, cwd, title, origin_kind, status,
                           durable_label, created_at, last_active_at, machine_id,
                           issue_id, ref_issue_id)
       VALUES ('${id}', '${firstAdminMemberId()}', 'claude-code', '/w', '${id}', 'spawn', 'live',
               'podium-${id}', 't', 't', '${m}',
               ${issueId === null ? 'NULL' : `'${issueId}'`},
               ${refIssueId === null ? 'NULL' : `'${refIssueId}'`});`
  db.exec(`
    ${machine(HOST, 'host')}
    ${machine(OTHER, 'other')}
    ${issue('i-unpinned', 1, '/w/unpinned', null)}
    ${issue('i-unpinned-host-session', 2, '/w/host', null)}
    ${issue('i-contradicted-current', 3, '/w/current', null)}
    ${issue('i-contradicted-birth', 4, '/w/birth', null)}
    ${issue('i-worktreeless', 5, null, null)}
    ${issue('i-already-pinned', 6, '/w/pinned', OTHER)}
    ${session('s-host', 'i-unpinned-host-session', null, HOST)}
    ${session('s-remote-current', 'i-contradicted-current', null, OTHER)}
    ${session('s-remote-birth', null, 'i-contradicted-birth', OTHER)}
  `)
  db.close()
}

describe('the run-once migration for legacy worktree machine identity', () => {
  it('pins a v0.1.0 database’s unpinned worktree issues to this host', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    // ANTI-VACUITY: the fixture really is unpinned before the boot. Without this,
    // an assertion that the rows end up on HOST would pass on a database the
    // backfill never touched.
    const before = machineIds(path)
    expect(before['i-unpinned']).toBeNull()
    expect(before['i-unpinned-host-session']).toBeNull()

    const store = await openTestStore(path, HOST)
    await store.close()

    const after = machineIds(path)
    expect(after['i-unpinned']).toBe(HOST)
    // A linked session on THIS host is not a contradiction — it is agreement.
    expect(after['i-unpinned-host-session']).toBe(HOST)
  })

  it('leaves a row NULL when a session on another machine contradicts this host', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    const store = await openTestStore(path, HOST)
    await store.close()

    const after = machineIds(path)
    // Routing these to the local disk is the failure the backfill was written to
    // avoid: the evidence says the worktree is somewhere else, so the row stays
    // NULL for manual recovery.
    expect(after['i-contradicted-current']).toBeNull()
    // The birth pointer counts too, so rehoming a session cannot erase the
    // evidence that its worktree was cut on another machine.
    expect(after['i-contradicted-birth']).toBeNull()
  })

  it('does not touch a worktree-less row, and opens rather than refusing over it', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    // The boot completing at all is half the assertion. A NULL machine_id on a
    // worktree-less row is LEGITIMATE, so this is the case that says why the
    // POD-3246 sentinel refusal must not be widened to fire on NULL machines.
    const store = await openTestStore(path, HOST)
    await store.close()

    expect(machineIds(path)['i-worktreeless']).toBeNull()
  })

  it('never overwrites an existing pin', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    const store = await openTestStore(path, HOST)
    await store.close()

    expect(machineIds(path)['i-already-pinned']).toBe(OTHER)
  })

  it('never revisits skipped or newly unpinned rows, and warns only once', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (await openTestStore(path, HOST)).close()
    expect(warning.mock.calls.filter(([message]) => String(message).includes('legacy worktree'))).toHaveLength(1)
    const db = openDatabase(path)
    const receipt = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WORKTREE_MIGRATION)
    expect(receipt).toEqual({ value: JSON.stringify({ hostMachineId: HOST, backfilled: 2, skipped: 2 }) })
    db.exec("DELETE FROM sessions; UPDATE issues SET machine_id = NULL WHERE id = 'i-unpinned'")
    const before = db.prepare('SELECT * FROM issues ORDER BY id').all()
    db.exec("CREATE TRIGGER refuse_issue_updates BEFORE UPDATE ON issues BEGIN SELECT RAISE(ABORT, 'boot wrote issues'); END")
    db.close()
    await (await openTestStore(path, HOST)).close()
    const after = openDatabase(path)
    expect(after.prepare('SELECT * FROM issues ORDER BY id').all()).toEqual(before)
    expect(after.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WORKTREE_MIGRATION)).toEqual(receipt)
    after.close()
    expect(warning.mock.calls.filter(([message]) => String(message).includes('legacy worktree'))).toHaveLength(1)
  })

  it('defers without a receipt until the host has an enrolled database row', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    await (await openTestStore(path, asMachineId('not-enrolled'))).close()
    const db = openDatabase(path)
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WORKTREE_MIGRATION)).toBeUndefined()
    db.close()
    expect(machineIds(path)['i-unpinned']).toBeNull()
    await (await openTestStore(path, HOST)).close()
    expect(machineIds(path)['i-unpinned']).toBe(HOST)
  })

  it('rolls back placement writes when the receipt cannot commit', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    const db = openDatabase(path)
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON meta WHEN NEW.key = '${LEGACY_WORKTREE_MIGRATION}'
      BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`)
    db.close()
    await expect(openTestStore(path, HOST)).rejects.toThrow()
    expect(machineIds(path)['i-unpinned']).toBeNull()
    const retry = openDatabase(path)
    expect(retry.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WORKTREE_MIGRATION)).toBeUndefined()
    retry.exec('DROP TRIGGER fail_receipt')
    retry.close()
    await (await openTestStore(path, HOST)).close()
    expect(machineIds(path)['i-unpinned']).toBe(HOST)
  })

  it('never reads or imports the retired repos.json path at boot', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    const retiredPath = join(dirname(path), 'repos.json')
    writeFileSync(retiredPath, JSON.stringify(['/retired-repo']))
    const reads = vi.mocked(fs.readFileSync)
    reads.mockClear()
    const db = openDatabase(path)
    const before = db.prepare('SELECT * FROM repos').all()
    db.exec("CREATE TRIGGER refuse_repo_import BEFORE INSERT ON repos BEGIN SELECT RAISE(ABORT, 'boot imported repos'); END")
    db.close()
    await (await openTestStore(path, HOST)).close()
    writeFileSync(retiredPath, 'invalid legacy JSON')
    await (await openTestStore(path, HOST)).close()
    expect(reads.mock.calls.some(([file]) => String(file) === retiredPath)).toBe(false)
    const after = openDatabase(path)
    expect(after.prepare('SELECT * FROM repos').all()).toEqual(before)
    after.close()
  })

  it('correlates the session evidence to the outer issue, not to itself', async () => {
    // NAMES THE MECHANISM the case above can only see through its consequence:
    // an unqualified `id` inside the EXISTS subquery binds to `sessions`, so the
    // contradiction test compares every session to itself, finds nothing, and
    // quietly pins the rows those assertions require to stay NULL. Read off the
    // count query, which shares `legacyWorktreeTerms` with the UPDATE.
    const store = await openTestStore(':memory:', HOST)
    const sql = store.issues.legacyWorktreeContradictionSql(HOST)
    await store.close()
    expect(sql).toContain('"issues"."id"')
    expect(sql).not.toContain('"sessions"."id"')
  })

  it('runs after the identity refusals, so no retired sentinel can reach it', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    const db = openDatabase(path)
    db.exec(`
      INSERT OR REPLACE INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
        VALUES ('local', 'legacy', 'legacy', '${sha256('legacy')}', 't', 't');
    `)
    db.close()

    await expect(openTestStore(path, HOST)).rejects.toThrow(/retired machine sentinels/)

    // THE ORDERING, not just the refusal. The deleted version got its
    // precondition from the legacy-machine rewrite that ran immediately before
    // it; that rewrite is gone, and the refusal supplies it instead — but only
    // while the backfill runs AFTER. Move the call up and this row comes back
    // pinned, because the backfill's own transaction commits before the refusal
    // throws, on a database whose stored machine ids cannot be trusted yet.
    expect(machineIds(path)['i-unpinned']).toBeNull()
  })
})
