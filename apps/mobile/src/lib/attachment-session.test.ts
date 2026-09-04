import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createAttachmentSessionResolver, uploadWithResolvedSession } from './attachment-session'

describe('lazy attachment session resolution', () => {
  it('does not create a session merely because the resolver exists', () => {
    const ensure = vi.fn(async () => asSessionId('new'))
    createAttachmentSessionResolver(() => undefined, ensure)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('shares one session creation across concurrent first attachments', async () => {
    const ensure = vi.fn(async () => asSessionId('new'))
    const resolve = createAttachmentSessionResolver(() => undefined, ensure)
    await expect(Promise.all([resolve(), resolve()])).resolves.toEqual([
      asSessionId('new'),
      asSessionId('new'),
    ])
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('uses an existing session without creating one', async () => {
    const ensure = vi.fn(async () => asSessionId('new'))
    const resolve = createAttachmentSessionResolver(() => asSessionId('existing'), ensure)
    await expect(resolve()).resolves.toBe(asSessionId('existing'))
    expect(ensure).not.toHaveBeenCalled()
  })

  it('does nothing after picker cancellation and creates one target for accepted bytes', async () => {
    const resolve = vi.fn(async () => asSessionId('target'))
    const upload = vi.fn(async () => {})
    await uploadWithResolvedSession([], resolve, upload)
    expect(resolve).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()

    await uploadWithResolvedSession(['photo'], resolve, upload)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith('photo', asSessionId('target'))
  })
})
