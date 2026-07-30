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
  it('detects the WINDOWS standalone-binary module URL (B:/~BUN root, ~ percent-encoded)', () => {
    // Probed on windows-latest inside a real compiled binary: import.meta.url is
    // file:///B:/%7EBUN/root/<binary>.exe — the ~ arrives PERCENT-ENCODED, which is
    // how both the '/$bunfs/' and literal '~BUN' checks missed it (crash-looping
    // the worker down the run-from-source branch). Bun.main is the raw form.
    expect(isCompiledBunfsUrl('file:///B:/%7EBUN/root/podium.exe')).toBe(true)
    expect(isCompiledBunfsUrl('B:/~BUN/root/podium.exe')).toBe(true)
    expect(isCompiledBunfsUrl('B:\\~BUN\\root\\worker-client.js')).toBe(true)
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
  it('Windows: raw B:/~BUN path with FORWARD slashes (the only form that resolves)', () => {
    // Probed on windows-latest: B:/~BUN/root/…/discovery-worker.js spawns OK; the
    // backslash form and the file:///B:/… URL both ENOENT; /$bunfs forms ModuleNotFound.
    expect(discoveryWorkerEmbeddedTarget('win32')).toBe(`B:/~BUN/root/${rel}`)
  })
})
