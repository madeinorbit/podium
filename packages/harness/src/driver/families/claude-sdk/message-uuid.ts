import { createHash } from 'node:crypto'

/**
 * THE NAMESPACE every derived Claude user-message uuid lives in (POD-4836).
 * Fixed forever: changing it renames every message Podium ever typed, and a
 * retry after the change would no longer be recognised as the same message.
 */
const PODIUM_MESSAGE_NAMESPACE = 'ee7e95f7-1bbc-4891-a7d6-c03a59a7afcd'

const MSG_UUID = /^msg_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * THE UUID A PODIUM MESSAGE IS TYPED INTO CLAUDE UNDER (POD-4836).
 *
 * The CLI records the user turn under the `uuid` of its stdin line (POD-4774),
 * so this is the id of the history entry the message becomes. It is derived
 * from the message id alone: every attempt at the same message, in any daemon
 * generation, sends the same uuid, and the entry can be found from the id.
 * `msg_<uuid>` (the app's ids) gives that uuid; any other id gives a
 * name-based (v5, RFC 9562) uuid of the id under one fixed namespace.
 *
 * The same uuid twice is NOT a second message to the CLI: measured on claude
 * 2.1.282 and 2.1.284, a line whose uuid the session already holds is skipped
 * (not recorded, not run), in the same process and after a `--resume`.
 */
export function claudeUserMessageUuid(messageId: string): string {
  const embedded = MSG_UUID.exec(messageId)
  if (embedded) return embedded[1]!.toLowerCase()
  const namespace = Buffer.from(PODIUM_MESSAGE_NAMESPACE.replaceAll('-', ''), 'hex')
  const bytes = createHash('sha1')
    .update(namespace)
    .update(messageId, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
