/**
 * A machine model's facts as a plain value (POD-6644).
 *
 * A machine model is live: its record fields, my access row and its LiveStore
 * condition are getters. A screen that reads it inside a mobx observer redraws
 * on each field it read (the machine panel does: one machine's update redraws
 * that row only). A hook that hands a machine to plain React code (pickers,
 * the chat offline bar, harness availability) needs a VALUE that changes when
 * a fact does; the model's identity never changes. This is that value: one
 * memoized snapshot per model, new only when one of its facts moved. It reads
 * the machine's row once (the record joined with my access row) and the live
 * condition once.
 */
import {
  effectiveServiceReport,
  type MachineFacts,
  type MachineServiceReport,
  serverMoveEligibilityOf,
} from '@podium/model'
import { compareStructural, computed, type IComputedValue } from 'mobx'
import { here } from './lookup'
import type { MachineModel } from './models'

const snapshots = new WeakMap<MachineModel, IComputedValue<MachineFacts>>()

function read(model: MachineModel): MachineFacts {
  const row = here(model.row) ?? {}
  const online = model.online
  const availability = model.availability
  const out: Record<string, unknown> = {
    ...row,
    id: model.id,
    online,
    onlineKnown: model.onlineKnown,
    services: effectiveServiceReport(
      row['services'] as MachineServiceReport | undefined,
      availability,
    ),
    serverMoveEligibility: serverMoveEligibilityOf(
      row as Parameters<typeof serverMoveEligibilityOf>[0],
      online,
    ),
  }
  const presence = {
    onlineSince: model.onlineSince,
    lastSeenAt: model.lastSeenAt,
    presenceSource: model.presenceSource,
    availability,
    daemonReadiness: model.daemonReadiness,
  }
  for (const [field, value] of Object.entries(presence)) if (value !== undefined) out[field] = value
  for (const field of Object.keys(out)) if (out[field] === undefined) delete out[field]
  return out as unknown as MachineFacts
}

/** The machine's facts now; the same object until one of them changes. */
export function machineFacts(model: MachineModel): MachineFacts {
  let snapshot = snapshots.get(model)
  if (!snapshot) {
    snapshot = computed(() => read(model), {
      equals: compareStructural,
      name: `machineFacts:${model.id}`,
    })
    snapshots.set(model, snapshot)
  }
  return snapshot.get()
}
