import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import type { ObservationLeaseRecord } from './types'

export type ObservationRebindResult =
  | {
      kind: 'accepted'
      disposition: 'advanced' | 'unchanged' | 'duplicate'
      lease: ObservationLeaseRecord
    }
  | {
      kind: 'rejected'
      rejectionReason: 'stale_observer_generation' | 'provider_binding_mismatch'
      lease: ObservationLeaseRecord
    }

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

  private readRebindReceipt(sessionId: string): {
    provider: ObservationLeaseRecord['provider']
    fromProviderSessionId: string | null
    fromBindingVersion: number
    fromObservationGeneration: number
    toProviderSessionId: string
    resultingBindingVersion: number
    resultingObservationGeneration: number
  } | null {
    const row = this.db
      .prepare(
        `SELECT provider, from_provider_session_id, from_binding_version,
                from_observation_generation, to_provider_session_id,
                resulting_binding_version, resulting_observation_generation
         FROM session_observation_rebinds WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined
    if (!row) return null
    const provider = ObservationProvider.safeParse(row.provider)
    if (!provider.success) return null
    return {
      provider: provider.data,
      fromProviderSessionId: (row.from_provider_session_id as string | null) ?? null,
      fromBindingVersion: Number(row.from_binding_version),
      fromObservationGeneration: Number(row.from_observation_generation),
      toProviderSessionId: row.to_provider_session_id as string,
      resultingBindingVersion: Number(row.resulting_binding_version),
      resultingObservationGeneration: Number(row.resulting_observation_generation),
    }
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

  /**
   * Atomically replace one exact native provider binding. Both fences advance,
   * so observations and acknowledgements from the predecessor become inert.
   * Duplicate old→already-current-next requests return the durable current
   * lease without advancing again, including after process restart. [spec:SP-cdb2]
   */
  rebindExact(input: {
    sessionId: string
    provider: ObservationLeaseRecord['provider']
    providerSessionId: string | null
    bindingVersion: number
    observationGeneration: number
    nextProviderSessionId: string
  }): ObservationRebindResult {
    return transaction(this.db, () => {
      const current = this.read(input.sessionId)
      if (!current) throw new Error(`missing observation lease for ${input.sessionId}`)
      if (current.provider !== input.provider) {
        return { kind: 'rejected', rejectionReason: 'provider_binding_mismatch', lease: current }
      }
      if (
        current.providerSessionId === input.nextProviderSessionId &&
        current.providerSessionId === input.providerSessionId &&
        current.bindingVersion === input.bindingVersion &&
        current.observationGeneration === input.observationGeneration
      ) {
        return { kind: 'accepted', disposition: 'unchanged', lease: current }
      }
      const receipt = this.readRebindReceipt(input.sessionId)
      if (
        receipt?.provider === input.provider &&
        receipt.fromProviderSessionId === input.providerSessionId &&
        receipt.fromBindingVersion === input.bindingVersion &&
        receipt.fromObservationGeneration === input.observationGeneration &&
        receipt.toProviderSessionId === input.nextProviderSessionId &&
        current.providerSessionId === input.nextProviderSessionId &&
        current.bindingVersion === receipt.resultingBindingVersion &&
        current.observationGeneration >= receipt.resultingObservationGeneration
      ) {
        return { kind: 'accepted', disposition: 'duplicate', lease: current }
      }
      if (current.observationGeneration !== input.observationGeneration) {
        return {
          kind: 'rejected',
          rejectionReason: 'stale_observer_generation',
          lease: current,
        }
      }
      if (
        current.providerSessionId !== input.providerSessionId ||
        current.bindingVersion !== input.bindingVersion
      ) {
        return { kind: 'rejected', rejectionReason: 'provider_binding_mismatch', lease: current }
      }

      const bindingVersion = current.bindingVersion + 1
      const observationGeneration = current.observationGeneration + 1
      const updatedAt = new Date().toISOString()
      const result = this.db
        .prepare(
          `UPDATE session_observation_checkpoints
           SET provider_session_id = ?,
               binding_version = ?,
               observation_generation = ?,
               checkpoint_json = ?,
               updated_at = ?
           WHERE session_id = ?
             AND provider = ?
             AND binding_version = ?
             AND observation_generation = ?
             AND (provider_session_id = ? OR (provider_session_id IS NULL AND ? IS NULL))`,
        )
        .run(
          input.nextProviderSessionId,
          bindingVersion,
          observationGeneration,
          null,
          updatedAt,
          input.sessionId,
          input.provider,
          input.bindingVersion,
          input.observationGeneration,
          input.providerSessionId,
          input.providerSessionId,
        )
      if (Number(result.changes) !== 1) {
        throw new Error(`observation rebind lease changed for ${input.sessionId}`)
      }
      this.db
        .prepare(
          `INSERT INTO session_observation_rebinds
             (session_id, provider, from_provider_session_id, from_binding_version,
              from_observation_generation, to_provider_session_id,
              resulting_binding_version, resulting_observation_generation, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             provider = excluded.provider,
             from_provider_session_id = excluded.from_provider_session_id,
             from_binding_version = excluded.from_binding_version,
             from_observation_generation = excluded.from_observation_generation,
             to_provider_session_id = excluded.to_provider_session_id,
             resulting_binding_version = excluded.resulting_binding_version,
             resulting_observation_generation = excluded.resulting_observation_generation,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.sessionId,
          input.provider,
          input.providerSessionId,
          input.bindingVersion,
          input.observationGeneration,
          input.nextProviderSessionId,
          bindingVersion,
          observationGeneration,
          updatedAt,
        )
      const lease = this.read(input.sessionId)
      if (!lease) throw new Error(`missing rebound observation lease for ${input.sessionId}`)
      return { kind: 'accepted', disposition: 'advanced', lease }
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
