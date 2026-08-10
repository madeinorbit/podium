import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asSessionId } from '@podium/model'
import { PortableStateFence } from './portable-state-fence'
import { removeSessionUploads, sweepUploads, UPLOADS_TTL_MS } from './session-uploads'

describe('transfer-fenced upload cleanup', () => {
  let root: string
  let sequence = 0

  beforeEach(async () => {
    root = join(tmpdir(), `podium-upload-fence-${process.pid}-${sequence++}`)
    await mkdir(root, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('blocks session deletion until a safe-abort resume', async () => {
    const fence = new PortableStateFence()
    const sessionId = asSessionId('session-delete')
    const upload = join(root, 'uploads', sessionId, 'image.png')
    await mkdir(join(root, 'uploads', sessionId), { recursive: true })
    await writeFile(upload, 'kept')
    await fence.pauseAndDrain()

    removeSessionUploads(sessionId, fence, root)
    await expect(access(upload)).resolves.toBeUndefined()

    fence.resume()
    removeSessionUploads(sessionId, fence, root)
    await expect(access(upload)).rejects.toThrow()
  })

  it('blocks the hourly GC sweep while fenced and permits it after resume', async () => {
    const fence = new PortableStateFence()
    const upload = join(root, 'uploads', 'session-gc', 'old.png')
    await mkdir(join(root, 'uploads', 'session-gc'), { recursive: true })
    await writeFile(upload, 'old')
    const old = new Date(Date.now() - UPLOADS_TTL_MS - 1_000)
    await utimes(upload, old, old)
    await fence.pauseAndDrain()

    await sweepUploads(fence, root)
    await expect(access(upload)).resolves.toBeUndefined()

    fence.resume()
    await sweepUploads(fence, root)
    await expect(access(upload)).rejects.toThrow()
  })
})
