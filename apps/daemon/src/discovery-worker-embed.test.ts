import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_WORKER_ENTRY,
  discoveryWorkerEmbeddedTarget,
  isCompiledBunfsUrl,
} from './discovery-worker-embed.js'

describe('isCompiledBunfsUrl', () => {
  it('detects the POSIX standalone-binary module URL (/$bunfs/)', () => {
    expect(isCompiledBunfsUrl('file:///$bunfs/root/podium')).toBe(true)
  })
  it('detects the WINDOWS standalone-binary module path (B:\\~BUN, plain path, backslashes)', () => {
    // Inside a Windows compiled binary import.meta.url is NOT a file:// URL — it is
    // a raw path under Bun's B:\~BUN virtual root (oven-sh/bun#16010). The original
    // '/$bunfs/' check (and a '/~BUN/' one) both missed it, sending the compiled
    // daemon down the run-from-source branch → ModuleNotFound crash-loop.
    expect(isCompiledBunfsUrl('B:\\~BUN\\root\\worker-client.js')).toBe(true)
    expect(isCompiledBunfsUrl('file:///B:/~BUN/root/podium.exe')).toBe(true)
  })
  it('is false for ordinary on-disk module URLs', () => {
    expect(isCompiledBunfsUrl('file:///home/u/podium/apps/daemon/src/worker-client.ts')).toBe(
      false,
    )
    expect(isCompiledBunfsUrl('file:///C:/Users/u/podium/apps/daemon/src/worker-client.ts')).toBe(
      false,
    )
  })
})

describe('discoveryWorkerEmbeddedTarget', () => {
  const rel = DISCOVERY_WORKER_ENTRY.replace(/\.ts$/, '.js')
  it('POSIX: file URL under /$bunfs/root', () => {
    expect(discoveryWorkerEmbeddedTarget('linux')).toBe(`file:///$bunfs/root/${rel}`)
  })
  it('Windows: a plain backslash path under B:\\~BUN\\root (matching import.meta.url form)', () => {
    expect(discoveryWorkerEmbeddedTarget('win32')).toBe(
      `B:\\~BUN\\root\\${rel.replaceAll('/', '\\')}`,
    )
  })
})
