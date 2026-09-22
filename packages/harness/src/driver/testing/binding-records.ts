/**
 * BINDING RECORDS WITH NO SESSION LAYER BEHIND THEM (POD-4611).
 *
 * In the daemon a family's binding record lives on the session's entry, with
 * a durable copy the session layer keeps (`apps/daemon/src/session/engines.ts`).
 * A family built on its own — a unit test, a conformance fixture — has no
 * session layer, so it gets this stand-in: one record per session id, the
 * same report/read shape. `address` is what the session layer would have
 * minted; a test that needs one seeds it. Production never constructs one.
 */

import type { SessionId } from '@podium/model'
import type {
  EngineAttachment,
  EngineBindingRecord,
  EngineBindingRecords,
  EngineSpawnRequest,
  SessionEngineOwner,
} from '../families/engine-supervision.js'

export interface MemoryBindingRecords<TFacts extends { sessionId: SessionId }>
  extends EngineBindingRecords<TFacts> {
  /** Every record held, by session — what a test asserts against. */
  readonly entries: Map<SessionId, EngineBindingRecord<TFacts>>
}

export function createMemoryBindingRecords<TFacts extends { sessionId: SessionId }>(
  seed: Iterable<EngineBindingRecord<TFacts>> = [],
): MemoryBindingRecords<TFacts> {
  const entries = new Map<SessionId, EngineBindingRecord<TFacts>>()
  for (const record of seed) entries.set(record.sessionId, record)
  return {
    entries,
    bound(facts) {
      const address = entries.get(facts.sessionId)?.address
      entries.set(facts.sessionId, { ...facts, ...(address !== undefined ? { address } : {}) })
    },
    released: (sessionId) => void entries.delete(sessionId),
    recorded: (sessionId) => entries.get(sessionId),
  }
}

/** The process verbs a test scripts, each answering the way the session
 *  layer's durable owner would. Unscripted verbs refuse or answer "nothing
 *  alive", so a test only states what it exercises. */
export interface TestEngineVerbs {
  startEngine?(req: EngineSpawnRequest): Promise<EngineAttachment>
  reattachEngine?(input: { label: string; fromSeq: 'tail' | bigint; sessionId?: SessionId }): Promise<EngineAttachment>
  engineAlive?(label: string): Promise<boolean>
  destroyEngine?(label: string, sessionId?: SessionId): Promise<void>
}

/**
 * A session engine owner with no session layer behind it: scripted process
 * verbs plus in-memory binding records. A request for a listener is handed
 * `unix://<socketRoot>/<n>.sock` — what the session layer would mint — and
 * the engine is told it through the family's `listen.argv`.
 */
export function createTestEngineOwner<TFacts extends { sessionId: SessionId }>(
  verbs: TestEngineVerbs = {},
  options: { records?: MemoryBindingRecords<TFacts>; socketRoot?: string } = {},
): SessionEngineOwner<TFacts> & { readonly records: MemoryBindingRecords<TFacts> } {
  const records = options.records ?? createMemoryBindingRecords<TFacts>()
  let minted = 0
  return {
    records,
    bound: (facts) => records.bound(facts),
    released: (sessionId) => records.released(sessionId),
    recorded: (sessionId) => records.recorded(sessionId),
    async startEngine(req) {
      if (!verbs.startEngine) throw new Error('unexpected startEngine')
      const address = req.listen
        ? `unix://${options.socketRoot ?? '/tmp'}/test-engine-${minted++}.sock`
        : undefined
      const args = req.listen && address ? [...req.args, ...req.listen.argv(address)] : req.args
      const attachment = await verbs.startEngine({ ...req, args })
      return { attachment, ...(address ? { address } : {}) }
    },
    async reattachEngine(input) {
      if (!verbs.reattachEngine) throw new Error('no engine host answers')
      const attachment = await verbs.reattachEngine(input)
      const address =
        input.sessionId !== undefined ? records.recorded(input.sessionId)?.address : undefined
      return { attachment, ...(address ? { address } : {}) }
    },
    engineAlive: (label) => verbs.engineAlive?.(label) ?? Promise.resolve(false),
    destroyEngine: (label, sessionId) => verbs.destroyEngine?.(label, sessionId) ?? Promise.resolve(),
  }
}
