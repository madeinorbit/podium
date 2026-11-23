import { describe, expect, it } from 'vitest'
import { JANITOR_WORKER_ENTRY, janitorWorkerEmbeddedTarget } from './janitor-worker-embed'

describe('janitor worker embedded target', () => {
  it('matches Bun virtual filesystem paths on POSIX and Windows', () => {
    const relative = JANITOR_WORKER_ENTRY.replace(/\.ts$/, '.js')
    expect(janitorWorkerEmbeddedTarget('linux')).toBe(`file:///$bunfs/root/${relative}`)
    expect(janitorWorkerEmbeddedTarget('win32')).toBe(`B:/~BUN/root/${relative}`)
  })
})
