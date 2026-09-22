import type { TranscriptItem } from '@podium/model'
// Extensionless: this module rides the `@podium/harness/browser` closure and
// its walker resolves extensionless specifiers, never `.js` — a `.js` hop
// here truncates that closure (checkBrowserGraphAll).
import { encodeCursor, SYNTHESIZED_ITEM_ID_PREFIX } from '../transcript-types'

export {
  decodeCursor,
  encodeCursor,
  SYNTHESIZED_ITEM_ID_PREFIX,
} from '../transcript-types'
export type { CursorParts } from '../transcript-types'

export function stampCursors(
  items: TranscriptItem[],
  fileId: string,
  offset: number,
  uuid: string | null,
): TranscriptItem[] {
  return items.map((item, sub) => {
    const cursor = encodeCursor({ fileId, offset, uuid, sub })
    return {
      ...item,
      id: item.id.startsWith(SYNTHESIZED_ITEM_ID_PREFIX) ? cursor : item.id,
      cursor,
    }
  })
}

export function recordUuid(record: unknown): string | null {
  if (
    record &&
    typeof record === 'object' &&
    typeof (record as { uuid?: unknown }).uuid === 'string'
  ) {
    return (record as { uuid: string }).uuid
  }
  return null
}
