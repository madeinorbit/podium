import { SYNC_BATCH_MAX_ROWS, SYNC_BATCH_TARGET_BYTES, SYNC_LINE_MAX_BYTES, type SyncRecord } from '@podium/protocol'

export interface SyncBytesEncoder {
  push(record: SyncRecord): Uint8Array | null
  flush(): Uint8Array | null
}

export class RowTooLarge extends Error {
  readonly reason = 'row-too-large' as const
  constructor(readonly bytes: number) {
    super(`Sync record exceeds ${SYNC_LINE_MAX_BYTES} bytes (${bytes})`)
    this.name = 'RowTooLarge'
  }
}

export class NdjsonEncoder implements SyncBytesEncoder {
  private readonly utf8 = new TextEncoder()
  private lines: Uint8Array[] = []
  private bytes = 0

  push(record: SyncRecord): Uint8Array | null {
    const line = this.utf8.encode(JSON.stringify(record))
    if (line.byteLength > SYNC_LINE_MAX_BYTES) throw new RowTooLarge(line.byteLength)
    this.lines.push(line)
    this.bytes += line.byteLength + 1
    return this.bytes >= SYNC_BATCH_TARGET_BYTES || this.lines.length >= SYNC_BATCH_MAX_ROWS
      ? this.flush() : null
  }

  flush(): Uint8Array | null {
    if (!this.bytes) return null
    const batch = new Uint8Array(this.bytes)
    let offset = 0
    for (const line of this.lines) {
      batch.set(line, offset)
      offset += line.byteLength
      batch[offset++] = 10
    }
    this.lines = []
    this.bytes = 0
    return batch
  }
}
