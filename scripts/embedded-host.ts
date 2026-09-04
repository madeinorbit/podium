import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
// Bun-compile-only: the prebuilt podium-host binary, embedded into the executable.
// Reached only by the `bun build --compile` entries, never by Node.
import hostEmbedded from '../dist-bun/podium-host.bin' with { type: 'file' }
import { defaultHostCachePath, hostSupported } from '../packages/pty/src/host-bin.js'

/**
 * In a `bun build --compile` binary the vendored host.c is not on disk, so the
 * runtime cc-build in host-bin.ts cannot run. Materialize the embedded host into
 * the resolver's cache path ($PODIUM_STATE_DIR/bin/podium-host) on first start.
 * An EMPTY embedded file (a cross build that shipped no host, or Windows) is a
 * "no host here" placeholder and materializes nothing: the daemon falls back to
 * abduco. A pre-existing cache or $PODIUM_HOST_BIN wins.
 */
export async function materializeEmbeddedHost(): Promise<void> {
  if (!hostSupported()) return
  if (process.env.PODIUM_HOST_BIN) return
  const cache = defaultHostCachePath()
  if (existsSync(cache)) return
  try {
    const bytes = new Uint8Array(await Bun.file(hostEmbedded).arrayBuffer())
    if (bytes.byteLength === 0) return
    mkdirSync(dirname(cache), { recursive: true })
    writeFileSync(cache, bytes)
    chmodSync(cache, 0o755)
    console.log(`[podium] materialized embedded podium-host -> ${cache}`)
  } catch (err) {
    console.warn(
      `[podium] could not materialize embedded podium-host: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
