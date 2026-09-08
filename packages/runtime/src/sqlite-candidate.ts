/**
 * Database half of candidate-file validation [POD-3270 / POD-3272].
 *
 * Lives in runtime so the daemon can call the SAME function the durability
 * port uses, without an app→app import. Enrollment-ledger checks stay in the
 * daemon: they are not a database file.
 */

import { openDatabase } from './sqlite'

export interface SqliteCandidateRequest {
  readonly databasePath: string
  readonly targetMachineId: string
  readonly expectedFeedId: string
  readonly expectedFeedEpoch: string
  readonly expectedSchemaVersion: string
}

export interface SqliteCandidateProof {
  readonly feedId: string
  readonly feedEpoch: string
  readonly schemaVersion: string
}

export type SqliteCandidateFailureCode = 'candidate-invalid' | 'identity-mismatch'

export class SqliteCandidateError extends Error {
  constructor(
    readonly code: SqliteCandidateFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'SqliteCandidateError'
  }
}

export function validateSqliteCandidate(request: SqliteCandidateRequest): SqliteCandidateProof {
  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(request.databasePath, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (integrity?.integrity_check !== 'ok') {
      throw new SqliteCandidateError('candidate-invalid', 'candidate database failed integrity_check')
    }
    const target = db.prepare('SELECT id FROM machines WHERE id = ?').get(request.targetMachineId)
    if (!target) {
      throw new SqliteCandidateError(
        'identity-mismatch',
        'target machine is absent from the candidate database',
      )
    }
    const feed = db.prepare('SELECT feed_id, epoch FROM feed_identity WHERE singleton = 1').get() as
      | { feed_id?: string; epoch?: string }
      | undefined
    if (!feed?.feed_id || !feed.epoch) {
      throw new SqliteCandidateError('candidate-invalid', 'candidate database has no feed identity')
    }
    const schema = db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name?: string } | undefined
    if (!schema?.name) {
      throw new SqliteCandidateError('candidate-invalid', 'candidate database has no schema ledger')
    }
    if (feed.feed_id !== request.expectedFeedId || feed.epoch !== request.expectedFeedEpoch) {
      throw new SqliteCandidateError(
        'identity-mismatch',
        'candidate feed identity does not match transfer manifest',
      )
    }
    if (schema.name !== request.expectedSchemaVersion) {
      throw new SqliteCandidateError(
        'candidate-invalid',
        'candidate schema does not match transfer manifest',
      )
    }
    return {
      feedId: feed.feed_id,
      feedEpoch: feed.epoch,
      schemaVersion: schema.name,
    }
  } catch (error) {
    if (error instanceof SqliteCandidateError) throw error
    throw new SqliteCandidateError('candidate-invalid', 'candidate database schema is not supported')
  } finally {
    db?.close()
  }
}
