import type { CheckoutWire } from '@podium/model'
import type { CheckoutRow } from './checkouts'

/** A stored row as the feed's record. */
export function checkoutWireOf(row: CheckoutRow): CheckoutWire {
  return {
    machineId: row.machineId,
    path: row.path,
    root: row.root,
    kind: row.kind,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.originUrl ? { originUrl: row.originUrl } : {}),
    ...(row.locked ? { locked: true } : {}),
    ...(row.prunable ? { prunable: true } : {}),
  }
}
