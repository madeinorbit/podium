/**
 * The expensive half of recovery-snapshot verification, isolated so it can only
 * ever run somewhere other than the server's event loop.
 *
 * NOTHING in this module may be imported by a request path. It opens the
 * snapshot file and runs `PRAGMA quick_check`, which reads the whole database.
 * It is written as a pure function of explicit PATHS and EXPECTED FACTS — never
 * a live SQLite handle — precisely so the process boundary in
 * `snapshot-verifier-child.ts` is the only way production reaches it.
 */

import { statSync } from 'node:fs'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { type SnapshotIdentity, sameSnapshotIdentity, snapshotIdentity } from './snapshot-catalogue'

export interface VerifySnapshotRequest {
  /** Absolute path of the snapshot main file. */
  path: string
  /** What the caller staged; a mismatch means the candidate moved on. */
  expected: SnapshotIdentity
  /** Migration identity the snapshot must carry, when the caller knows it. */
  expectedSchemaVersion?: string
  /** Echoed back so a result can be matched to the run that was launched. */
  correlationId: string
}

export type VerifySnapshotFailureCode =
  | 'missing'
  | 'empty'
  | 'identity-mismatch'
  | 'corrupt'
  | 'schema-mismatch'
  | 'unreadable'

export type VerifySnapshotResult =
  | { ok: true; correlationId: string; schemaVersion?: string; bytes: number; durationMs: number }
  | {
      ok: false
      correlationId: string
      code: VerifySnapshotFailureCode
      detail: string
      durationMs: number
    }

/** The snapshot's own migration identity, or `undefined` when it has none. */
function schemaVersionOf(db: SqlDatabase): string | undefined {
  try {
    const row = db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name?: unknown } | undefined
    return typeof row?.name === 'string' && row.name.length > 0 ? row.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Open the staged file read-only, prove it is a readable SQLite database with
 * the expected identity, and report the result. Never throws: a verifier that
 * crashed and a verifier that found corruption must be distinguishable, and
 * both are outcomes rather than exceptions.
 */
export function verifySnapshotFile(
  request: VerifySnapshotRequest,
  now: () => number = Date.now,
): VerifySnapshotResult {
  const startedAt = now()
  const fail = (code: VerifySnapshotFailureCode, detail: string): VerifySnapshotResult => ({
    ok: false,
    correlationId: request.correlationId,
    code,
    detail,
    durationMs: now() - startedAt,
  })

  const actual = snapshotIdentity(request.path)
  if (!actual) return fail('missing', 'the staged snapshot file is not present')
  if (actual.size === 0) return fail('empty', 'the staged snapshot file is empty')
  if (!sameSnapshotIdentity(actual, request.expected)) {
    return fail(
      'identity-mismatch',
      `staged identity ${request.expected.size}/${request.expected.mtimeMs} no longer matches ` +
        `${actual.size}/${actual.mtimeMs}`,
    )
  }

  let db: SqlDatabase | undefined
  try {
    db = openDatabase(request.path, { readOnly: true })
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    const answer = row ? Object.values(row)[0] : undefined
    if (answer !== 'ok') return fail('corrupt', `quick_check answered ${String(answer)}`)
    const schemaVersion = schemaVersionOf(db)
    if (request.expectedSchemaVersion && schemaVersion !== request.expectedSchemaVersion) {
      return fail(
        'schema-mismatch',
        `snapshot carries migration ${schemaVersion ?? 'none'}, expected ${request.expectedSchemaVersion}`,
      )
    }
    return {
      ok: true,
      correlationId: request.correlationId,
      ...(schemaVersion ? { schemaVersion } : {}),
      bytes: statSync(request.path).size,
      durationMs: now() - startedAt,
    }
  } catch (error) {
    return fail('unreadable', error instanceof Error ? error.message : String(error))
  } finally {
    db?.close()
  }
}
