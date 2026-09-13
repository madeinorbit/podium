/**
 * **A TWO-PART FEED ROW ID, ESCAPED** — the rule four files already spell
 * separately, written once for the fifth (PDM-408) and the sixth (PDM-424).
 *
 * **THIS FILE EXISTS ON TWO UNLANDED BRANCHES AND THE CODE BELOW IS IDENTICAL
 * ON BOTH.** PDM-408 wrote it for `issueMarks` on
 * `issue/pdm-402-per-viewer-issue-marks`; this copy is on PDM-424's branch for
 * `sessionMarks`. Neither is landed, and each needs it for the same reason, so
 * duplicating it was the alternative to making one issue unlandable until the
 * other lands. Whichever lands second resolves the conflict by KEEPING ONE FILE
 * — the bodies are byte-identical, so there is nothing to merge but this header.
 * Do not rename or re-point either caller.
 *
 * A change-log `entityId` is one string, but several kinds are keyed by a PAIR:
 * `userLayout` is `(userId, key)`, `userReadPosition` is `(userId, streamId)`,
 * `pendingInteraction` is `(sessionId, interactionId)`, `issueEvent` is
 * `(eventId, subject)`, `issueMarks` is `(userId, issueId)` and `sessionMarks`
 * is `(userId, sessionId)`. Every one of
 * them joins on `\n` and escapes both the separator and the backslash, so a part
 * containing the separator cannot collide with a different pair.
 *
 * **WHY THIS IS SHARED AND NOT A FIFTH COPY.** For `issueMarks` and
 * `sessionMarks` the parse is load-bearing in a way the others' are not:
 * `feed-visibility.ts` decides WHO RECEIVES the row by parsing the user back out
 * of its id. A parser that
 * disagreed with its writer by a single escape would deliver one person's pins
 * and unread state to another — which is the exact defect PDM-402/PDM-408/PDM-424
 * exist to close, reintroduced one layer down.
 *
 * The four existing copies are deliberately NOT re-pointed at this helper in the
 * same change: they are load-bearing on their own live paths, they have their own
 * round-trip tests, and folding them in here would put an unrelated refactor
 * inside a phase-gating fix. Filed separately.
 */

const ROW_SEP = '\n'

const escapePart = (part: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(ROW_SEP, `\\${ROW_SEP}`)

/** Join two parts into one collision-free row id. */
export function compositeRowId(first: string, second: string): string {
  return `${escapePart(first)}${ROW_SEP}${escapePart(second)}`
}

/**
 * Split a {@link compositeRowId} back into its two parts.
 *
 * Throws rather than returning a partial result, and `label` names the kind in
 * the message: a malformed id reaching a visibility arm must fail loudly at the
 * parse, because the alternative — a best-effort split — is a row delivered to
 * whoever the garbage happened to name.
 */
export function parseCompositeRowId(id: string, label: string): [string, string] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== ROW_SEP) {
        throw new Error(`malformed ${label} row id: ${JSON.stringify(id)}`)
      }
      current += next
      i += 1
    } else if (ch === ROW_SEP) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  if (parts.length !== 2) throw new Error(`malformed ${label} row id: ${JSON.stringify(id)}`)
  return [parts[0] as string, parts[1] as string]
}
