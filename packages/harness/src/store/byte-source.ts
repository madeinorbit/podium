import { open, stat } from 'node:fs/promises'

/**
 * The bytes of one transcript segment, wherever they are stored (POD-6963
 * design §2.6). The transcript readers (`readFileItems`, the bounded chain
 * reader, `readIndexWindow`) read only through this, so the same reader serves
 * a native file on the daemon and the server's transcript lake.
 *
 * A source is cheap to build and holds no open handle; each call does its own
 * I/O. A missing source fails its calls (a file source throws the native
 * error, ENOENT included), which the readers map exactly as they map an
 * unreadable file.
 */
export interface ByteSource {
  /** Stable identity of the byte stream across reads and appends: the path
   *  for a file. The parsed-slice caches key on it (with `version()`), so two
   *  sources that may hold different bytes never share an id. */
  readonly id: string
  size(): Promise<number>
  /** Bytes `[offset, offset + length)`. Shorter only at the end of the source. */
  read(offset: number, length: number): Promise<Uint8Array>
  /** Changes whenever the bytes may have changed: size + mtime for a file,
   *  cursor + open part's etag for the lake. */
  version(): Promise<string>
}

/** A file on local disk; its version is its size and mtime. */
export function fileByteSource(path: string): ByteSource {
  return {
    id: path,
    async size() {
      return (await stat(path)).size
    },
    async read(offset, length) {
      const handle = await open(path, 'r')
      try {
        const buf = Buffer.alloc(Math.max(0, length))
        const { bytesRead } = await handle.read(buf, 0, buf.length, Math.max(0, offset))
        return buf.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
    async version() {
      const st = await stat(path)
      return `${st.size}:${st.mtimeMs}`
    },
  }
}
