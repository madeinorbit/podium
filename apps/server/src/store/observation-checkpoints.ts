import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import type { ObservationLeaseRecord } from './types'

/** Durable causal observer leases and checkpoints [spec:SP-cdb2]. */
export class ObservationCheckpointsRepository {
  constructor(private readonly db: SqlDatabase) {}

  private mapRow(r: Record<string, unknown>): ObservationLeaseRecord | null {
    const provider = ObservationProvider.safeParse(r.provider)
    if (!provider.success) {
      console.warn(
        `[podium] ignoring observation lease for ${String(r.session_id)}: invalid provider`,
      )
      return null
    }
    let checkpoint: ObservationLeaseRecord['checkpoint'] = null
    if (r.checkpoint_json != null) {
      try {
        const parsed = SessionObservationCheckpointV1.safeParse(
          typeof r.checkpoint_json === 'string' ? JSON.parse(r.checkpoint_json) : r.checkpoint_json,
        )
        if (!parsed.success) throw new Error(parsed.error.message)
        checkpoint = parsed.data
      } catch (err) {
        console.warn(
          `[podium] ignoring corrupt observation checkpoint for ${String(r.session_id)}:`,
          err,
        )
      }
    }
    return {
      sessionId: r.session_id as string,
      provider: provider.data,
      providerSessionId: (r.provider_session_id as string | null) ?? null,
      bindingVersion: Number(r.binding_version),
      observationGeneration: Number(r.observation_generation),
      checkpoint,
      updatedAt: r.updated_at as string,
    }
  }

  private read(sessionId: string): ObservationLeaseRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_id, provider, provider_session_id, binding_version,
                observation_generation, checkpoint_json, updated_at
         FROM session_observation_checkpoints WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined
    return row ? this.mapRow(row) : null
  }

  loadAll(): ObservationLeaseRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, provider, provider_session_id, binding_version,
                observation_generation, checkpoint_json, updated_at
         FROM session_observation_checkpoints ORDER BY session_id`,
      )
      .all() as Record<string, unknown>[]
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is ObservationLeaseRecord => row !== null)
  }

  get(sessionId: string): ObservationLeaseRecord | null {
    return this.read(sessionId)
  }

  /**
   * Fence a new observer before spawn/reattach is sent. Existing exact provider
   * identity is never replaced by a conflicting resume hint.
   */
  advanceGeneration(
    sessionId: string,
    provider: ObservationLeaseRecord['provider'],
    providerSessionId: string | null,
  ): ObservationLeaseRecord {
    return transaction(this.db, () => {
      const updatedAt = new Date().toISOString()
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_observation_checkpoints
             (session_id, schema_version, provider, provider_session_id,
              binding_version, observation_generation, checkpoint_json, updated_at)
           VALUES (?, 1, ?, ?, 1, 0, NULL, ?)`,
        )
        .run(sessionId, provider, providerSessionId, updatedAt)
      this.db
        .prepare(
          `UPDATE session_observation_checkpoints
           SET observation_generation = observation_generation + 1,
               provider_session_id = COALESCE(provider_session_id, ?),
               updated_at = ?
           WHERE session_id = ? AND provider = ?`,
        )
        .run(providerSessionId, updatedAt, sessionId, provider)
      const lease = this.read(sessionId)
      if (!lease || lease.provider !== provider) {
        throw new Error(`unable to advance observation generation for ${sessionId}`)
      }
      return lease
    })
  }

  /** Persist only against the still-current lease; stale sockets cannot win. */
  save(checkpoint: SessionObservationCheckpointV1): void {
    const result = this.db
      .prepare(
        `UPDATE session_observation_checkpoints
         SET provider_session_id = COALESCE(provider_session_id, ?),
             checkpoint_json = ?,
             updated_at = ?
         WHERE session_id = ?
           AND provider = ?
           AND binding_version = ?
           AND observation_generation = ?
           AND (provider_session_id IS NULL OR provider_session_id = ?)`,
      )
      .run(
        checkpoint.providerSessionId,
        JSON.stringify(checkpoint),
        checkpoint.acceptedAt,
        checkpoint.podiumSessionId,
        checkpoint.provider,
        checkpoint.bindingVersion,
        checkpoint.lifecycleObservationGeneration,
        checkpoint.providerSessionId,
      )
    if (Number(result.changes) !== 1) {
      throw new Error(`observation checkpoint lease changed for ${checkpoint.podiumSessionId}`)
    }
  }

  purge(sessionId: string): void {
    this.db
      .prepare('DELETE FROM session_observation_checkpoints WHERE session_id = ?')
      .run(sessionId)
  }
}
