/**
 * Attention-tier math for the daemon's PTY output scheduler (#194: moved from
 * apps/server/src/session-priority.ts — pure, platform-neutral, belongs in
 * domain alongside the other session-identity predicates).
 */
export interface PriorityClient {
  attached: ReadonlySet<string>
  viewVisible: ReadonlySet<string>
  focused: string | null
}

/** Per session, the strongest tier ANY client assigns it (lower = higher priority):
 *  0 focused, 1 visible, 2 attached, 3 unwatched. */
export function computePriorities(
  clients: Iterable<PriorityClient>,
  sessionIds: Iterable<string>,
): Map<string, 0 | 1 | 2 | 3> {
  const out = new Map<string, 0 | 1 | 2 | 3>()
  for (const sid of sessionIds) {
    let best: 0 | 1 | 2 | 3 = 3
    for (const c of clients) {
      if (c.focused === sid) {
        best = 0
        break
      }
      if (c.viewVisible.has(sid)) best = best < 1 ? best : 1
      else if (c.attached.has(sid)) best = best < 2 ? best : 2
    }
    out.set(sid, best)
  }
  return out
}
