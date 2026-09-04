/**
 * Both directions, planted [POD-3391].
 *
 * The audit's claim is an ABSENCE — "no converted call site declares a write as
 * a read" — and an absence is what a broken instrument reports. So every test
 * here that matters plants a disagreement and demands it is caught with BOTH
 * values named, and the quiet cases are asserted quiet in the same file.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import { openHarness } from './harness'
import { auditStatement, callSite, deriveWriteEvidence, IntentAudit } from './intent-audit'
import { instrumentDriver, StatementProbeHub } from './statement-probe'

describe('deriveWriteEvidence', () => {
  it.each([
    ['INSERT INTO notes (body) VALUES (?)', 'leading INSERT'],
    ['  update counters set value = 1', 'leading UPDATE'],
    ['DELETE FROM notes WHERE id = ?', 'leading DELETE'],
    ['REPLACE INTO counters VALUES (?, ?)', 'leading REPLACE'],
    ['CREATE TABLE t (id INTEGER)', 'leading CREATE (DDL)'],
    [
      'WITH doomed AS (SELECT id FROM notes) DELETE FROM notes WHERE id IN (SELECT id FROM doomed)',
      'DML under a WITH prefix',
    ],
  ])('reads %s as a write', (sql, reason) => {
    expect(deriveWriteEvidence(sql)).toEqual({ evidence: 'write', reason })
  })

  it('reads a RETURNING clause as a write whatever the method — the POD-3321 case', () => {
    expect(deriveWriteEvidence('INSERT INTO notes (body) VALUES (?) RETURNING id')).toEqual({
      evidence: 'write',
      reason: 'RETURNING clause',
    })
  })

  it.each([
    'SELECT * FROM notes',
    'WITH recent AS (SELECT id FROM notes) SELECT * FROM recent',
    "SELECT body FROM notes WHERE body = 'DELETE FROM notes'",
    "SELECT 'x RETURNING y' AS lie",
    '-- DELETE FROM notes\nSELECT 1',
    'SELECT "DELETE" FROM notes',
  ])('reads %s as a read', (sql) => {
    expect(deriveWriteEvidence(sql).evidence).toBe('read')
  })

  it.each([
    'PRAGMA journal_mode = WAL',
    'PRAGMA user_version',
    'EXPLAIN INSERT INTO notes VALUES (1, ?)',
    'ANALYZE',
  ])('refuses to grade %s rather than guessing', (sql) => {
    expect(deriveWriteEvidence(sql).evidence).toBe('inconclusive')
  })
})

describe('auditStatement grades the two errors differently', () => {
  it('is FATAL when a write is declared a read, and names both values', () => {
    const finding = auditStatement({ sql: 'INSERT INTO notes (body) VALUES (?)', intent: 'read' })
    expect(finding).toMatchObject({
      disagreement: 'write-declared-read',
      fatal: true,
      declared: 'read',
      derived: 'write',
      reason: 'leading INSERT',
    })
  })

  it('reports but does NOT fail a read declared as a write — rule 16 makes write the default', () => {
    const finding = auditStatement({ sql: 'SELECT * FROM notes', intent: 'write' })
    expect(finding).toMatchObject({
      disagreement: 'read-declared-write',
      fatal: false,
      declared: 'write',
      derived: 'read',
    })
  })

  it('says nothing when the declaration agrees', () => {
    expect(auditStatement({ sql: 'SELECT 1', intent: 'read' })).toBeUndefined()
    expect(
      auditStatement({ sql: 'INSERT INTO notes (body) VALUES (?)', intent: 'write' }),
    ).toBeUndefined()
  })

  it('says nothing about a statement it refuses to grade, in EITHER declaration', () => {
    expect(auditStatement({ sql: 'PRAGMA journal_mode = WAL', intent: 'read' })).toBeUndefined()
    expect(auditStatement({ sql: 'PRAGMA user_version', intent: 'write' })).toBeUndefined()
  })
})

describe('IntentAudit counts what it examined', () => {
  it('counts every graded statement, so a run that checked nothing cannot read as a pass', () => {
    const audit = new IntentAudit()
    audit.observe({ sql: 'SELECT 1', intent: 'read' })
    audit.observe({ sql: 'INSERT INTO notes (body) VALUES (?)', intent: 'write' })
    audit.observe({ sql: 'PRAGMA user_version', intent: 'read' })
    expect(audit.totals).toEqual({ examined: 3, derivedWrite: 1, derivedRead: 1, inconclusive: 1 })
    expect(audit.findings).toHaveLength(0)
  })

  it('skips the legacy raw-handle seam, which has no call site to have declared anything', () => {
    const audit = new IntentAudit()
    audit.observe({ sql: 'INSERT INTO notes (body) VALUES (?)', intent: 'undeclared' })
    expect(audit.totals.examined).toBe(0)
  })
})

describe('callSite', () => {
  const stack = [
    'Error: statement issued',
    '    at execute (/repo/apps/server/src/store/executor/statement-probe.ts:254:30)',
    '    at execute (/repo/apps/server/src/store/executor/harness.ts:89:24)',
    '    at all (/repo/apps/server/src/store/executor/driver.ts:285:28)',
    '    at /repo/apps/server/src/store/sessions.ts:412:19',
    '    at /repo/apps/server/src/modules/sessions/service.ts:88:7',
  ].join('\n')

  it('names the first frame outside the executor, not the seam that observed it', () => {
    expect(callSite(stack)).toBe('/repo/apps/server/src/store/sessions.ts:412')
  })

  it('does NOT skip a test file that lives beside the executor — it is a call site', () => {
    const fromTest = [
      'Error: statement issued',
      '    at execute (/repo/apps/server/src/store/executor/statement-probe.ts:254:30)',
      '    at /repo/apps/server/src/store/executor/executor.test.ts:1971:22',
    ].join('\n')
    expect(callSite(fromTest)).toBe('/repo/apps/server/src/store/executor/executor.test.ts:1971')
  })

  it('says unattributed rather than guessing when there is no stack', () => {
    expect(callSite(undefined)).toBe('unattributed')
  })
})

/**
 * THROUGH A REAL DRIVER, not the pure function.
 *
 * The pure tests above prove the rule. This proves the MECHANISM: that a
 * statement issued by a call site reaches the audit at all, on the seam every
 * lane goes through, with the intent `queryClientOver` bound to the method the
 * call site chose.
 */
describe('the audit at the driver seam', () => {
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-3391-'))
    const raw = openDatabase(join(dir, 'audit.db'))
    raw.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    const hub = new StatementProbeHub()
    const audit = new IntentAudit()
    hub.attach(audit.probe, { wantsIssueSite: true })
    const driver = instrumentDriver(createBunSqliteDriver({ database: raw }), hub)
    return {
      audit,
      driver,
      close: async () => {
        await driver.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  it('catches an INSERT a call site declared as a read, through the real client', async () => {
    const { audit, driver, close } = open()
    const session = await driver.open('write')
    // The planted defect: `all` declares `read` (queryClientOver), and this is
    // an INSERT. Issued through the client, not hand-built, so the declaration
    // is the one a converted repository would really get.
    const client = driver.client(
      (statement) => session.execute(statement),
      (statements) => session.executeBatch(statements),
    )
    await client.all("INSERT INTO notes (body) VALUES ('planted')")
    await session.close()
    await close()

    expect(audit.totals.examined).toBe(1)
    expect(audit.fatal).toHaveLength(1)
    const [finding] = audit.fatal
    expect(finding).toMatchObject({ declared: 'read', derived: 'write', reason: 'leading INSERT' })
    expect(finding?.sql).toContain('INSERT INTO notes')
    // The site is the line in THIS file that issued it, not the seam that saw it.
    expect(finding?.site).toContain('intent-audit.test.ts:')
  })

  it('reports, without failing, a SELECT a call site declared as a write', async () => {
    const { audit, driver, close } = open()
    const session = await driver.open('write')
    const client = driver.client(
      (statement) => session.execute(statement),
      (statements) => session.executeBatch(statements),
    )
    await client.writeAll('SELECT * FROM notes')
    await session.close()
    await close()

    expect(audit.totals.examined).toBe(1)
    expect(audit.fatal).toHaveLength(0)
    expect(audit.findings).toHaveLength(1)
    expect(audit.findings[0]).toMatchObject({
      disagreement: 'read-declared-write',
      declared: 'write',
      derived: 'read',
    })
  })

  /**
   * THROUGH THE EXECUTOR, which is the only depth that pins the attribution.
   *
   * The seam tests above call `execute` almost directly, and a stack built
   * anywhere in that shallow chain still shows the test. A real statement
   * crosses the router, the scope, the in-flight tracker and the lease before it
   * reaches the driver, and by the time the probe runs in the `finally` those
   * frames are gone — which is why the stack is captured at the driver's door
   * BEFORE the await. Attribute after the await and this test reports
   * `unattributed`.
   *
   * It uses a PRIVATE audit: it plants a real defect, and the lane audit is what
   * the gate reads.
   */
  it('names the repository line, not the seam, for a statement issued through the executor', async () => {
    const audit = new IntentAudit()
    const harness = openHarness({ intentAudit: audit })
    await harness.executor.transact(async (tx) => {
      await tx.drizzle.all("INSERT INTO notes (body) VALUES ('planted-through-the-executor')")
    })
    await harness.close()

    expect(audit.fatal).toHaveLength(1)
    expect(audit.fatal[0]?.site).toMatch(/intent-audit\.test\.ts:\d+$/)
  })

  it('stays quiet on correctly declared traffic, and still counts it', async () => {
    const { audit, driver, close } = open()
    const session = await driver.open('write')
    const client = driver.client(
      (statement) => session.execute(statement),
      (statements) => session.executeBatch(statements),
    )
    await client.run("INSERT INTO notes (body) VALUES ('honest')")
    await client.writeGet("INSERT INTO notes (body) VALUES ('honest') RETURNING id")
    await client.all('SELECT * FROM notes')
    await client.get('SELECT * FROM notes WHERE id = 1')
    await session.close()
    await close()

    expect(audit.findings).toHaveLength(0)
    expect(audit.totals).toEqual({ examined: 4, derivedWrite: 2, derivedRead: 2, inconclusive: 0 })
  })
})
