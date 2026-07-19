import { describe, expect, it } from 'vitest'
import {
  isCompiledBunfsUrl,
  PUBLISH_WORKER_ENTRY,
  publishWorkerEmbeddedTarget,
} from './publish-worker-embed.js'

describe('publish worker compiled-runtime detection', () => {
  it('recognizes POSIX and Windows Bun virtual roots', () => {
    expect(isCompiledBunfsUrl('file:///$bunfs/root/podium')).toBe(true)
    expect(isCompiledBunfsUrl('file:///B:/%7EBUN/root/podium.exe')).toBe(true)
    expect(isCompiledBunfsUrl('B:/~BUN/root/podium.exe')).toBe(true)
  })

  it('does not classify source modules as compiled', () => {
    expect(isCompiledBunfsUrl('file:///work/podium/apps/server/src/index.ts')).toBe(false)
  })
})

describe('publishWorkerEmbeddedTarget', () => {
  const embedded = PUBLISH_WORKER_ENTRY.replace(/\.ts$/, '.js')

  it('uses Bun virtual-fs URLs in compiled POSIX binaries', () => {
    expect(publishWorkerEmbeddedTarget('linux')).toBe(`file:///$bunfs/root/${embedded}`)
  })

  it('uses the raw forward-slash Bun path in compiled Windows binaries', () => {
    expect(publishWorkerEmbeddedTarget('win32')).toBe(`B:/~BUN/root/${embedded}`)
  })
})
