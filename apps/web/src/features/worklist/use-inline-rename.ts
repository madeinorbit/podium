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
 */
export function useInlineRename(current: string, onRename: (next: string) => void): InlineRename {
  const [editing, setEditing] = useState(false)
  return {
    editing,
    begin: () => setEditing(true),
    cancel: () => setEditing(false),
    commit: (next: string) => {
      const trimmed = next.trim()
      if (trimmed && trimmed !== current) onRename(trimmed)
      setEditing(false)
    },
  }
}

/** Convenience for the row's `editor` slot: the node when open, `undefined`
 *  when closed, so a row can pass it straight through. */
export function inlineRenameEditor(
  rename: InlineRename,
  render: (props: { onCommit: (next: string) => void; onCancel: () => void }) => ReactNode,
): ReactNode | undefined {
  return rename.editing ? render({ onCommit: rename.commit, onCancel: rename.cancel }) : undefined
}
