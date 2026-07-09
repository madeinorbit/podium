/**
 * TEMPORARY diagnostic for the Windows compiled-binary worker-spawn path (#90) —
 * remove once windows-smoke is green. Compiled by CI exactly like the production
 * binary (this file + the discovery worker as an extra entrypoint, common ancestor
 * = repo root) and run so the logs show, on the actual runner:
 *   - what import.meta.url looks like inside a Windows standalone binary,
 *   - which spawn-target form actually reaches the embedded worker.
 */
import { Worker } from 'node:worker_threads'
import {
  DISCOVERY_WORKER_ENTRY,
  discoveryWorkerEmbeddedTarget,
  isCompiledBunfsUrl,
} from '../apps/daemon/src/discovery-worker-embed.js'

declare const Bun: { main?: string } | undefined

console.log('[probe] import.meta.url =', JSON.stringify(import.meta.url))
console.log('[probe] Bun.main =', JSON.stringify(typeof Bun !== 'undefined' ? Bun.main : null))
console.log('[probe] isCompiledBunfsUrl =', isCompiledBunfsUrl(import.meta.url))
console.log('[probe] chosen target =', JSON.stringify(discoveryWorkerEmbeddedTarget()))

const rel = DISCOVERY_WORKER_ENTRY.replace(/\.ts$/, '.js')
const candidates: string[] = [
  discoveryWorkerEmbeddedTarget(),
  `B:\\~BUN\\root\\${rel.replaceAll('/', '\\')}`,
  `B:/~BUN/root/${rel}`,
  `file:///B:/~BUN/root/${rel}`,
  `/$bunfs/root/${rel}`,
  `file:///$bunfs/root/${rel}`,
]

for (const c of [...new Set(candidates)]) {
  const verdict = await new Promise<string>((resolve) => {
    let done = false
    const finish = (v: string, w?: Worker): void => {
      if (done) return
      done = true
      try {
        void w?.terminate()
      } catch {}
      resolve(v)
    }
    try {
      const w = new Worker(c, { type: 'module' } as never)
      w.on('error', (e) => finish(`error: ${String(e).slice(0, 120)}`, w))
      w.on('exit', (code) => finish(`exited ${code}`, w))
      // No error/exit shortly after spawn = the module resolved and is running.
      setTimeout(() => finish('OK (alive)', w), 1500)
    } catch (e) {
      finish(`threw: ${String(e).slice(0, 120)}`)
    }
  })
  console.log(`[probe] ${JSON.stringify(c)} -> ${verdict}`)
}
process.exit(0)
