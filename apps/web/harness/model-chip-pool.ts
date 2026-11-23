/**
 * The pool the model chip reads, stood down for the harness (POD-6523): each
 * session's latest `session.configure` record, set by the page.
 */
import { observable, runInAction } from 'mobx'
import type { ModelChipSession } from '@/features/chat/SessionModelChip'

const records = observable.map<string, Record<string, unknown>>(undefined, { deep: false })
const effects = observable.map<string, Record<string, unknown>>(undefined, { deep: false })
export const chipSessions = new Map<string, ModelChipSession>()
export const chipChanges: { sessionId: string; patch: { model?: string; effort?: string } }[] = []

export function setConfigureChange(sessionId: string, record: Record<string, unknown>): void {
  runInAction(() => {
    records.set(sessionId, record)
    effects.set(record.id as string, record)
  })
}

const pool = {
  sessionObject: (id: string) => ({ configureChange: records.get(id) }),
  tables: { effect: effects },
  model: (_kind: string, id: string) => effects.get(id),
}

export async function configureChip(
  sessionId: string,
  patch: { model?: string; effort?: string },
): Promise<string> {
  const id = `eff_harness_${chipChanges.length}`
  chipChanges.push({ sessionId, patch })
  const record = observable({
    id,
    kind: 'session.configure',
    status: 'pending',
    inFlight: true,
    input: patch,
    createdAt: new Date().toISOString(),
    result: undefined as unknown,
  })
  setConfigureChange(sessionId, record)
  setTimeout(
    () =>
      runInAction(() => {
        const session = chipSessions.get(sessionId)
        if (session && patch.model !== undefined) session.requestedModel = patch.model
        if (session && patch.effort !== undefined) session.requestedEffort = patch.effort
        record.status = 'succeeded'
        record.inFlight = false
        record.result = { ok: true, effective: 'next-turn' }
      }),
    250,
  )
  return id
}

Object.assign(window, { __modelChipProof: { changes: chipChanges } })

export function useWorklistPool(): typeof pool {
  return pool
}
