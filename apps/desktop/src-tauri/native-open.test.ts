// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

interface NativeOpenWindow extends Window {
  __PODIUM_DELIVER_NATIVE_OPEN__?: (raw: unknown) => void
  __PODIUM_NATIVE_OPEN_READY__?: (ready?: boolean) => void
}

const bridge = readFileSync(join(__dirname, 'native-open.js'), 'utf8')
const nativeWindow = window as NativeOpenWindow

beforeEach(() => {
  delete nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__
  delete nativeWindow.__PODIUM_NATIVE_OPEN_READY__
  window.eval(bridge)
})

describe('desktop native-open page bridge', () => {
  it('queues cold URLs until the listener is ready and drains each once', () => {
    const received: unknown[] = []
    const onOpen = (event: Event): void => received.push((event as CustomEvent).detail)
    const first = 'podium://issues/POD-1710?literal=%27quoted%27'
    const second = 'podium://sessions/POD-1710-A'

    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.(first)
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.(second)
    window.addEventListener('podium:native-open', onOpen)
    nativeWindow.__PODIUM_NATIVE_OPEN_READY__?.(true)
    nativeWindow.__PODIUM_NATIVE_OPEN_READY__?.(true)

    expect(received).toEqual([first, second])
    window.removeEventListener('podium:native-open', onOpen)
  })

  it('delivers warm URLs once and queues across a listener handoff', () => {
    const received: unknown[] = []
    const onOpen = (event: Event): void => received.push((event as CustomEvent).detail)
    window.addEventListener('podium:native-open', onOpen)
    nativeWindow.__PODIUM_NATIVE_OPEN_READY__?.()

    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://sessions/POD-1710-A')
    nativeWindow.__PODIUM_NATIVE_OPEN_READY__?.(false)
    nativeWindow.__PODIUM_DELIVER_NATIVE_OPEN__?.('podium://issues/POD-1710')
    expect(received).toEqual(['podium://sessions/POD-1710-A'])

    nativeWindow.__PODIUM_NATIVE_OPEN_READY__?.(true)
    expect(received).toEqual(['podium://sessions/POD-1710-A', 'podium://issues/POD-1710'])
    window.removeEventListener('podium:native-open', onOpen)
  })
})
