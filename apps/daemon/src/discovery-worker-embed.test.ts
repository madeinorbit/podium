import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_WORKER_ENTRY,
  discoveryWorkerEmbeddedUrl,
  isCompiledBunfsUrl,
} from './discovery-worker-embed.js'

describe('isCompiledBunfsUrl', () => {
  it('detects the POSIX standalone-binary module URL (/$bunfs/)', () => {
    expect(isCompiledBunfsUrl('file:///$bunfs/root/podium')).toBe(true)
  })
  it('detects the WINDOWS standalone-binary module URL (B:/~BUN/)', () => {
    // Bun's virtual filesystem root is B:\~BUN on Windows — the /$bunfs marker
    // never appears there, which is exactly how the worker spawn regressed
    // (fell into the run-from-source branch inside the compiled binary).
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

describe('discoveryWorkerEmbeddedUrl', () => {
  const rel = DISCOVERY_WORKER_ENTRY.replace(/\.ts$/, '.js')
  it('POSIX: file URL under /$bunfs/root', () => {
    expect(discoveryWorkerEmbeddedUrl('linux')).toBe(`file:///$bunfs/root/${rel}`)
  })
  it('Windows: file URL under B:/~BUN/root (drive keeps the triple slash)', () => {
    const url = discoveryWorkerEmbeddedUrl('win32')
    expect(url).toBe(`file:///B:/~BUN/root/${rel}`)
    // A malformed file://B:/… would parse the drive letter as a URL HOST.
    expect(new URL(url).host).toBe('')
  })
})
