/**
 * WHO MAY READ A MACHINE'S CHECKOUTS (POD-6644; coordinator decision POD-5620,
 * 2026-11-09). One rule, used by the feed's per-row check
 * (`feed-visibility.ts`) and by the access-row writer that records each
 * member's reach (`modules/machines/records.ts`), so the two can never disagree.
 *
 *  - A registered root is readable with MANAGE or USE; a worktree only with USE.
 *  - `use` and `manage` are explicit edges, inert once nobody holds custody
 *    (`machine-access.ts`). Administration grants MANAGE, never USE (D19.4b):
 *    admins manage every machine, and alone manage one nobody holds custody of.
 */

/** What a member may read of one machine's checkouts. */
export type CheckoutReach = 'all' | 'roots' | 'none'
/** What one access-row write took away from a member's reach. */
export type LostCheckoutReach = 'worktrees' | 'roots' | 'all'

interface MachineEdge {
  readonly grantee: string
  readonly verb: string
  readonly custody?: boolean
}

/** The members who read a machine's checkouts: USE holders read every one,
 *  managers the roots. */
export interface CheckoutReaders {
  readonly users: ReadonlySet<string>
  readonly managers: ReadonlySet<string>
}

export function checkoutReaders(
  edges: readonly MachineEdge[],
  admins: ReadonlySet<string>,
): CheckoutReaders {
  const custodian = edges.some((edge) => edge.verb === 'manage' && edge.custody === true)
  if (!custodian) return { users: new Set(), managers: new Set(admins) }
  return {
    users: new Set(edges.filter((edge) => edge.verb === 'use').map((edge) => edge.grantee)),
    managers: new Set([
      ...edges.filter((edge) => edge.verb === 'manage').map((edge) => edge.grantee),
      ...admins,
    ]),
  }
}

export function reachOf(userId: string, readers: CheckoutReaders): CheckoutReach {
  if (readers.users.has(userId)) return 'all'
  if (readers.managers.has(userId)) return 'roots'
  return 'none'
}

/** What a member could read before and may not after; `null` when nothing. */
export function lostReach(before: CheckoutReach, after: CheckoutReach): LostCheckoutReach | null {
  const lostWorktrees = before === 'all' && after !== 'all'
  const lostRoots = before !== 'none' && after === 'none'
  if (lostWorktrees && lostRoots) return 'all'
  if (lostWorktrees) return 'worktrees'
  if (lostRoots) return 'roots'
  return null
}

/** Which kinds of checkout a reach and a loss cover, together. */
export function reachCovers(
  reach: CheckoutReach,
  lost: LostCheckoutReach | null,
): { readonly roots: boolean; readonly worktrees: boolean } {
  return {
    roots: reach !== 'none' || lost === 'roots' || lost === 'all',
    worktrees: reach === 'all' || lost === 'worktrees' || lost === 'all',
  }
}
