/**
 * THE @-MENTION MECHANISM (POD-412) — trigger detection and token insertion, as
 * pure functions over `(value, caret)`.
 *
 * This is the half of the picker that has nothing to do with React, the DOM or
 * what a mention MEANS. `useAtMention` drives it, `AtMentionMenu` draws the
 * result, and each composer supplies its own options — so a change to "what does
 * typing `@` do" happens once, here, instead of once per composer.
 *
 * Lifted from the superagent composer's inline menu, which shipped first and
 * proved the shape. Two things changed on the way out:
 *
 *   - the caret. The original re-focused the textarea after inserting, which
 *     drops the caret at the END of the draft; mentioning a file in the middle
 *     of a sentence then sent you back to hunt for your place. Insertion now
 *     reports where the caret belongs and the hook puts it there.
 *   - dismissal. Escape used to clear the query, and the very next keystroke —
 *     still inside the same `@word` — re-opened the menu, so the menu could not
 *     actually be dismissed. The trigger now carries the `@`'s position, which
 *     is what lets a dismissal stick to one mention rather than to one query.
 */

/**
 * What a mention can refer to. A closed union rather than a free string: the
 * menu maps every kind to an icon, so adding one is a compile error at the place
 * that has to draw it instead of a row with a blank leading column.
 */
export type AtMentionKind = 'issue' | 'file' | 'repo' | 'worktree' | 'conversation'

/**
 * One offered mention.
 *
 * `insert` is deliberately per-option and not derived from the kind: each kind
 * inserts the vocabulary that already means something downstream — a bare
 * `POD-412` (which the transcript renders as a ref chip and an agent resolves
 * with the issue CLI), a backticked path (which renders as a file chip), or the
 * superagent's own `@label(ref)` token. The picker is the input side of a
 * vocabulary that already exists on the output side; it does not invent one.
 */
export interface AtOption {
  readonly kind: AtMentionKind
  /** Stable list key — unique across the whole option list. */
  readonly id: string
  /** The row's primary text: the ref, the filename, the repo name. */
  readonly label: string
  /** Dim trailing context: the issue title, the containing directory, the path. */
  readonly detail: string
  /** Exactly what replaces the `@…` in the draft. */
  readonly insert: string
}

/** An open `@…` at the caret: where it starts, what has been typed into it, and
 *  where it ends. `caret` is the end because the query is, by construction, the
 *  text between the `@` and the caret. */
export interface AtTrigger {
  /** Index of the `@` itself in the value. */
  readonly at: number
  /** What has been typed after the `@` — the empty string right after typing it. */
  readonly query: string
  /** Caret position, i.e. the end of the query. */
  readonly caret: number
}

/**
 * The `@` mention being typed at `caret`, or null.
 *
 * A mention must start the line or follow whitespace — `user@host` and an email
 * address are not mentions — and it runs while the characters are the ones
 * paths, refs and names are made of. A space therefore ENDS a mention, which is
 * what closes the menu without any explicit dismissal in the common case.
 */
export function readAtTrigger(value: string, caret: number): AtTrigger | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)))
  const match = /(?:^|\s)@([\w./-]*)$/.exec(before)
  if (!match) return null
  const query = match[1] ?? ''
  return { at: before.length - query.length - 1, query, caret: before.length }
}

/** A value with `trigger` replaced by `token`, and where the caret belongs after
 *  the edit. One trailing space follows the token so the next word is not glued
 *  to it — unless the caller was already typing in front of one. */
export function applyMention(
  value: string,
  trigger: AtTrigger,
  token: string,
): { value: string; caret: number } {
  const rest = value.slice(trigger.caret)
  const spacer = rest.startsWith(' ') ? '' : ' '
  return {
    value: value.slice(0, trigger.at) + token + spacer + rest,
    caret: trigger.at + token.length + spacer.length,
  }
}
