/**
 * RETIRING AN OPTIMISTIC TURN WHEN THE REAL ONE ARRIVES.
 *
 * A pending row is painted the instant the operator sends, and dropped once the
 * transcript carries the same turn. Matching on text alone was enough while a
 * prompt was only words. It stops being enough the moment a prompt can carry
 * files: the server lifts the attachment paths OUT of the text and onto the
 * item's `toolPaths`, so the echo of `"/uploads/s1/shot.png\nwhat is this?"`
 * comes back as `"what is this?"` and never equals what was sent. The bubble
 * then says "sending…" forever, under a transcript that already answered.
 *
 * So paths win where a turn has them — they are the stronger identity anyway,
 * being server-minted and unique per upload — and text is the fallback for the
 * ordinary prose turn. FIFO consumption, so two identical prompts retire two
 * bubbles rather than the same one twice. The desktop settled on exactly this
 * (`reconcilePending` in `apps/web/src/features/chat/chat.ts`); it is one rule
 * and the two clients must not disagree about it.
 */

export interface EchoablePendingTurn {
  text: string
  /** Files attached to this turn, in the order they were sent. */
  files?: readonly { path: string }[]
}

export interface EchoedUserItem {
  text: string
  toolPaths?: readonly string[]
}

export function dropEchoedPendingTurns<T extends EchoablePendingTurn>(
  pending: readonly T[],
  userItems: readonly EchoedUserItem[],
): T[] {
  if (pending.length === 0) return [...pending]
  const remaining = [...userItems]
  return pending.filter((turn) => {
    const paths = (turn.files ?? []).map((file) => file.path)
    const at = remaining.findIndex((item) => {
      const itemPaths = item.toolPaths ?? []
      if (paths.length > 0) {
        return itemPaths.length === paths.length && paths.every((path, i) => itemPaths[i] === path)
      }
      return item.text.trim() === turn.text.trim()
    })
    if (at === -1) return true
    remaining.splice(at, 1)
    return false
  })
}
