/**
 * FEED ROW IDENTITY for the PendingInteraction aggregate (POD-2020, spec §4).
 *
 * The change-log id for a `pendingInteraction` row is `(sessionId, id)`, not the
 * bare interaction id, for the same reason `issueEventRowId` carries its
 * subject: the visibility rule for an ask is "may this person read that
 * session?", and the decision has to be answerable AFTER the row is gone. A
 * `delete`/tombstone carries no value, so if the subject were only inside the
 * payload there would be nothing left to scope it by — and a bootstrap would owe
 * one `SELECT` per ask instead of one batched read of every subject session.
 *
 * The interaction ID ALONE would not do it even for live rows: it is a mint
 * (`ixn_<uuid>`) with no structure, deliberately, so that the aggregate can key
 * rows the same way whether the ask came from a driver's own namespace or from
 * this server's synthesizer.
 *
 * The escaping is `issueEventRowId`'s, verbatim in shape: a session id
 * containing the separator must not be able to forge a different subject.
 */

const ROW_SEP = '\n'

const esc = (part: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(ROW_SEP, `\\${ROW_SEP}`)

/** The change-log entityId for one interaction. */
export function interactionRowId(sessionId: string, interactionId: string): string {
  return `${esc(sessionId)}${ROW_SEP}${esc(interactionId)}`
}

/** Inverse of {@link interactionRowId}. Throws on a malformed id. */
export function parseInteractionRowId(id: string): { sessionId: string; interactionId: string } {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== ROW_SEP) {
        throw new Error(`malformed interaction row id: ${JSON.stringify(id)}`)
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
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`malformed interaction row id: ${JSON.stringify(id)}`)
  }
  return { sessionId: parts[0]!, interactionId: parts[1]! }
}
