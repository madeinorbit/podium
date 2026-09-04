// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { TerminalView } from './terminal-view'

describe('TerminalView.write', () => {
  it('streams a UTF-8 code point split across byte writes', async () => {
    const view = new TerminalView({ renderer: 'dom' })

    view.write(Uint8Array.of(0xe2, 0x82))
    view.write(Uint8Array.of(0xac))

    await vi.waitFor(() => expect(view.screenText()).toContain('€'))
    expect(view.screenText()).not.toContain('�')
    view.dispose()
  })

  it('keeps direct string writes source-compatible', async () => {
    const view = new TerminalView({ renderer: 'dom' })

    view.write('plain text')

    await vi.waitFor(() => expect(view.screenText()).toContain('plain text'))
    view.dispose()
  })
})
