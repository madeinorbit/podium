import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { InputEvent } from '../events.js'
import { attachRawSource } from './raw.js'

describe('attachRawSource', () => {
  it('emits parsed events and buffers split sequences', () => {
    const stream = new EventEmitter()
    const got: InputEvent[] = []
    const detach = attachRawSource(stream as unknown as NodeJS.ReadStream, (e) => got.push(e))

    stream.emit('data', Buffer.from('\x1b[1;5', 'latin1')) // partial Ctrl+Up
    expect(got).toHaveLength(0)
    stream.emit('data', Buffer.from('A', 'latin1')) // completes it
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ label: 'Ctrl+Up' })

    detach()
  })
})
