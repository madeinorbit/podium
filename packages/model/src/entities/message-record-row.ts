/**
 * FEED ROW IDENTITY for a chat message record (POD-4764).
 *
 * A message a person sent into a session rides the metadata feed as kind
 * `message`, so its delivery status reaches every device by id. Two people may
 * read that row: the person who sent it and the owner of the session it was
 * sent to. Both are in the change-log id, for the reason `interactionRowId`
 * carries its session: visibility has to be answerable from the id alone — a
 * `remove` carries no value — and a bootstrap must prefetch every subject
 * session in one batched read rather than one `SELECT` per message.
 *
 * The escaping is `issueEventRowId`'s: a part containing the separator must not
 * be able to forge a different session or sender.
 */

const ROW_SEP = '\n'

const esc = (part: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(ROW_SEP, `\\${ROW_SEP}`)

export interface MessageRecordRowParts {
  /** The session the message was sent to. */
  readonly sessionId: string
  /** The user who sent it. */
  readonly senderUserId: string
  /** The message's own id — the one the sender minted. */
  readonly messageId: string
}

/** The change-log entityId for one message record. */
export function messageRecordRowId(parts: MessageRecordRowParts): string {
  return [parts.sessionId, parts.senderUserId, parts.messageId].map(esc).join(ROW_SEP)
}

/** Inverse of {@link messageRecordRowId}. Throws on a malformed id. */
export function parseMessageRecordRowId(id: string): MessageRecordRowParts {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== ROW_SEP) {
        throw new Error(`malformed message record row id: ${JSON.stringify(id)}`)
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
  const [sessionId, senderUserId, messageId] = parts
  if (parts.length !== 3 || !sessionId || !senderUserId || !messageId) {
    throw new Error(`malformed message record row id: ${JSON.stringify(id)}`)
  }
  return { sessionId, senderUserId, messageId }
}
