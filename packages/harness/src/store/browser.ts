/**
 * Browser-safe half of the transcript identity contract. Parsing, paging and
 * tailing remain behind the host-only root barrel; these pure cursor helpers
 * are the only transcript machinery a rendered feed needs.
 */
export { decodeCursor, encodeCursor } from './cursor-codec'
export { streamIdOfCursor, streamItemIdOf } from './stream-identity'
