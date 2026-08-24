/**
 * INLINE RENAME (POD-407) — the rename lifecycle, extracted from
 * `SidebarUnified`.
 *
 * The INPUT was already shared (`SessionNameEditor` in `@/lib/WorkerLabel`); what
 * was not was the small state machine around it — open, commit, cancel, and the
 * COMMIT POLICY that decides whether a mutation happens at all. That policy is
 * the part worth having one copy of:
 *
 *   trim, then no-op on empty/whitespace or on an unchanged value (#170).
 *
 * Both halves matter and for different reasons. Trimming is obvious. The no-op is
 * not: a row opens its editor on DOUBLE-CLICK, and the editor commits on BLUR, so
 * an accidental double-click followed by a click elsewhere would fire a rename
 * mutation with the value it already had — a write, a revision bump and a feed
 * change for a user action that expressed no intent. Anything reachable by
 * fumbling has to be inert when it changes nothing.
 *
 * The name a rename WRITES is a human-set name, and per [spec:SP-eb60]
 * `nameSource: 'user'` outranks an agent-set one. That distinction is the
 * server's to stamp from the transport principal (ADR 3 D7) — this hook sends the
 * text and nothing else. It deliberately carries no actor, owner or origin in its
 * payload, per readiness §3.1.3 A3.
 */
import type { ReactNode } from 'react'
import { useState } from 'react'

export interface InlineRename {
  /** The value the open editor was seeded with — `null` while closed. The field
   *  reads this rather than the live name so what it holds and what a commit is
   *  measured against are one string. */
  readonly seed: string | null
  /** True while the editor is open — the row swaps its label block for it. */
  readonly editing: boolean
  /** Open the editor (double-click the label, or the context menu's Rename). */
  readonly begin: () => void
  /** Close without writing. */
  readonly cancel: () => void
  /** Apply the commit policy and close. */
  readonly commit: (next: string) => void
}

/**
 * The rename state machine for one row.
 *
 * `current` is the value shown when the editor opens and the value a commit is
 * compared against, so a rename to the existing name is correctly a no-op.
 * `onRename` is called ONLY when the value genuinely changed.
 *
 * THE COMPARAND IS SNAPSHOT ON OPEN (POD-1618), not read live at commit time.
 * The field is uncontrolled — it holds whatever it was seeded with — and the
 * name it was seeded FROM can move underneath it while it is open: a draft's
 * displayed name is its agent's, and an agent renames itself whenever it calls
 * `podium session title`. Measured against the live value, that turns the
 * fumble this policy exists to absorb into a write: the operator opens the
 * editor, an agent two panels away renames itself, the operator clicks away,
 * and the stale text in the field — no longer equal to the live name — is
 * committed as a title nobody chose. Snapshotting makes "unchanged" mean what
 * the operator saw, which is the only reading they can act on.
 */
export function useInlineRename(current: string, onRename: (next: string) => void): InlineRename {
  const [seed, setSeed] = useState<string | null>(null)
  return {
    seed,
    editing: seed !== null,
    // Re-opening an ALREADY open editor keeps the first snapshot. Nothing
    // remounts the field, so it still holds the text it was seeded with, and
    // re-reading `current` here would put the comparand back out of step with
    // it — the same drift the snapshot exists to prevent. (Both entry points
    // land here: the double-click and the context menu's Rename.)
    begin: () => setSeed((prev) => prev ?? current),
    cancel: () => setSeed(null),
    commit: (next: string) => {
      const trimmed = next.trim()
      if (trimmed && trimmed !== seed) onRename(trimmed)
      setSeed(null)
    },
  }
}

/** Convenience for the row's `editor` slot: the node when open, `undefined`
 *  when closed, so a row can pass it straight through.
 *
 *  `value` is the SNAPSHOT, handed over rather than left to the call site to
 *  re-derive: seeding the field from anything else is what reopens the stale
 *  commit above. */
export function inlineRenameEditor(
  rename: InlineRename,
  render: (props: {
    value: string
    onCommit: (next: string) => void
    onCancel: () => void
  }) => ReactNode,
): ReactNode | undefined {
  return rename.seed === null
    ? undefined
    : render({ value: rename.seed, onCommit: rename.commit, onCancel: rename.cancel })
}
