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

/** Which kinds of checkout a reach covers. */
export function reachCovers(reach: CheckoutReach): {
  readonly roots: boolean
  readonly worktrees: boolean
} {
  return { roots: reach !== 'none', worktrees: reach === 'all' }
}

/** Whether a reach covers this checkout (a root, or a worktree). */
export function covers(reach: CheckoutReach, checkout: { readonly root: boolean }): boolean {
  const kinds = reachCovers(reach)
  return checkout.root ? kinds.roots : kinds.worktrees
}
