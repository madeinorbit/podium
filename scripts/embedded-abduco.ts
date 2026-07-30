import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { abducoSupported, defaultAbducoCachePath } from '../packages/agent-bridge/src/abduco-bin.js'
// Bun-compile-only: the prebuilt abduco binary, embedded into the executable. This
// import uses Bun's `type: "file"` attribute and is only ever reached by the
// `bun build --compile` daemon entry (scripts/daemon-compiled.ts), never by Node.
import abducoEmbedded from '../dist-bun/abduco.bin' with { type: 'file' }

declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

/**
 * In a `bun build --compile` binary the vendored abduco.c is not on disk, so the
 * runtime cc-build fallback in abduco-bin.ts cannot run. Instead we embed a prebuilt
 * abduco and, on first start, materialize it into the resolver's cache path
 * ($PODIUM_STATE_DIR/bin/abduco) so resolveAbducoBin() finds it — no compiler, no
 * network, true single-download. A pre-existing cache or $PODIUM_ABDUCO wins.
 */
export async function materializeEmbeddedAbduco(): Promise<void> {
  // Windows builds embed an empty placeholder (no abduco there — sessions run on the
  // ConPTY backend without a durable host [spec:SP-7f2c]); nothing to materialize.
  if (!abducoSupported()) return
  if (process.env.PODIUM_ABDUCO) return // operator override wins
  const cache = defaultAbducoCachePath()
  if (existsSync(cache)) return // already present (system install copied here earlier, or a prior run)
  try {
    mkdirSync(dirname(cache), { recursive: true })
    const bytes = new Uint8Array(await Bun.file(abducoEmbedded).arrayBuffer())
    writeFileSync(cache, bytes)
    chmodSync(cache, 0o755)
    console.log(`[podium] materialized embedded abduco -> ${cache}`)
  } catch (err) {
    console.warn(
      `[podium] could not materialize embedded abduco: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
