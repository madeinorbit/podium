/**
 * THE BOOT BACKFILL A v0.1.0 DATABASE STILL NEEDS (POD-3359).
 *
 * POD-3246 retired three one-time boot upgrades on the premise that every
 * database had already crossed the build carrying them. That premise did not
 * hold for the worktree-machine backfill. It was introduced by 3416b5cec on
 * 2026-08-23, three days AFTER the only stable release v0.1.0 (79c588880,
 * 2026-08-20), and `git tag --contains 3416b5cec` names no stable tag — only
 * `dev`, `v0.1.1-edge.3` and `v0.1.1-edge.4`. The operator's minimum supported
 * upgrade version is v0.1.0, so a database may arrive here having never run it.
 * Nothing upstream catches that: the drizzle adoption build 938ad5bd is INSIDE
 * v0.1.0, so such a database is already drizzle-native and the migration runtime
 * opens it without complaint.
 *
 * WHAT THIS FILE HAS TO SHOW, given the backfill is RESTORED code rather than new
 * code: that it does something. The pinning case and the boot wiring are asserted
 * here, so removing either the call in `initialize()` or the UPDATE in the
 * repository turns this file red.
 *
 * AND THE HALF THAT IS EASIER TO GET WRONG: the rows it must NOT touch. A NULL
 * `machine_id` is legitimate for a worktree-less or genuinely contradicted row,
 * which is exactly why the POD-3246 sentinel refusal cannot cover this class and
 * must not be widened to try — it would refuse boots that are perfectly correct.
 * Each of those rows is asserted still NULL, and the boot is asserted to open.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestStore } from './test-support/open-test-store'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const dirs: string[] = []
const tmpDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-legacy-worktree-machine-'))
  dirs.push(dir)
  return join(dir, 'podium.db')
}
afterEach(() => {
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
  ;(await openTestStore(path, HOST)).close()
  const db = openDatabase(path)
  const machine = (id: string, name: string): string =>
    `INSERT OR REPLACE INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
       VALUES ('${id}', '${name}', '${name}', '${sha256(id)}', 't', 't');`
  const issue = (id: string, seq: number, worktree: string | null, pin: string | null): string =>
    `INSERT INTO issues (id, repo_id, repo_path, seq, title, stage, default_agent,
                         created_at, updated_at, worktree_path, machine_id)
       VALUES ('${id}', 'repo:one', '/r', ${seq}, '${id}', 'backlog', 'claude-code',
               't', 't', ${worktree === null ? 'NULL' : `'${worktree}'`},
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
       VALUES ('${id}', 'user:sole', 'claude-code', '/w', '${id}', 'spawn', 'live',
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

describe('the boot backfill for legacy worktree machine identity', () => {
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
    store.close()

    const after = machineIds(path)
    expect(after['i-unpinned']).toBe(HOST)
    // A linked session on THIS host is not a contradiction — it is agreement.
    expect(after['i-unpinned-host-session']).toBe(HOST)
  })

  it('leaves a row NULL when a session on another machine contradicts this host', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    const store = await openTestStore(path, HOST)
    store.close()

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
    store.close()

    expect(machineIds(path)['i-worktreeless']).toBeNull()
  })

  it('never overwrites an existing pin', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)

    const store = await openTestStore(path, HOST)
    store.close()

    expect(machineIds(path)['i-already-pinned']).toBe(OTHER)
  })

  it('changes nothing on a second boot', async () => {
    const path = tmpDb()
    await seedV010ShapedDb(path)
    ;(await openTestStore(path, HOST)).close()
    const afterFirst = machineIds(path)

    const store = await openTestStore(path, HOST)
    // The count the operator sees, read directly: a rerun reports zero work,
    // which is what makes this safe to leave in the boot path indefinitely.
    const rerun = await store.issues.backfillLegacyWorktreeMachineIds(HOST)
    store.close()

    expect(rerun.backfilled).toBe(0)
    // The contradicted rows stay countable on every boot — that is how the
    // operator learns the backfill deliberately left work behind.
    expect(rerun.skipped).toBe(2)
    expect(machineIds(path)).toEqual(afterFirst)
  })

  it('correlates the session evidence to the outer issue, not to itself', async () => {
    // NAMES THE MECHANISM the case above can only see through its consequence:
    // an unqualified `id` inside the EXISTS subquery binds to `sessions`, so the
    // contradiction test compares every session to itself, finds nothing, and
    // quietly pins the rows those assertions require to stay NULL. Read off the
    // count query, which shares `legacyWorktreeTerms` with the UPDATE.
    const store = await openTestStore(':memory:', HOST)
    const sql = store.issues.legacyWorktreeContradictionSql(HOST)
    store.close()
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
