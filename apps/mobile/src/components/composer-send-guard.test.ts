import { describe, expect, it } from 'vitest'
import { createSendGuard, DUPLICATE_SEND_WINDOW_MS } from './composer-send-guard'

describe('composer send guard', () => {
  const clock = () => {
    let t = 1_000
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('drops the same words pressed twice inside the window', () => {
    const time = clock()
    const guard = createSendGuard(time.now)
    expect(guard.admit('a long prompt')).toBe(true)
    time.advance(400)
    expect(guard.admit('a long prompt')).toBe(false)
  })

  it('lets a deliberate resend through once the window has passed', () => {
    const time = clock()
    const guard = createSendGuard(time.now)
    expect(guard.admit('again')).toBe(true)
    time.advance(DUPLICATE_SEND_WINDOW_MS)
    expect(guard.admit('again')).toBe(true)
  })

  it('never holds back different words, or the same words with other files', () => {
    const time = clock()
    const guard = createSendGuard(time.now)
    expect(guard.admit('one')).toBe(true)
    expect(guard.admit('two')).toBe(true)
    expect(guard.admit('two', ['upload-1'])).toBe(true)
    time.advance(10)
    expect(guard.admit('two', ['upload-1'])).toBe(false)
  })

  it('compares the words the agent would receive, ignoring edge whitespace', () => {
    const guard = createSendGuard(() => 0)
    expect(guard.admit('ship it')).toBe(true)
    expect(guard.admit('ship it\n')).toBe(false)
  })
})
