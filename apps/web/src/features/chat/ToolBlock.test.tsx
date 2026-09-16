import { asSessionId, type TranscriptItem } from '@podium/model/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolBlock } from './ToolBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function mount(input: Partial<TranscriptItem>): void {
  act(() => {
    root.render(
      <ToolBlock
        block={{ item: { id: 'bash', role: 'tool', text: '', toolName: 'Bash', ...input } }}
        sessionId={asSessionId('s1')}
        cwd="/repo"
        openFile={() => {}}
      />,
    )
  })
}
function unfold(): void {
  act(() => host.querySelector('button')?.click())
}

describe('Bash tool command colouring', () => {
  it('keeps long command tokens inside one truncating flex child without clipping the source', () => {
    const command = `echo "$HOME" ${'"a long argument" '.repeat(40)}# final comment`
    mount({ toolInput: command })
    const row = host.querySelector('.tool-row')
    const commandCell = host.querySelector('.tool-cmd')
    expect(commandCell?.parentElement).toBe(row)
    expect(commandCell?.classList.contains('min-w-0')).toBe(true)
    expect(commandCell?.classList.contains('truncate')).toBe(true)
    expect(commandCell?.textContent).toBe(command)
    expect(row?.querySelectorAll(':scope > .tool-cmd')).toHaveLength(1)
    expect(row?.querySelectorAll(':scope > [class^="hljs-"]')).toHaveLength(0)
    expect(commandCell?.querySelector('.hljs-string')).not.toBeNull()
    expect(commandCell?.querySelector('.hljs-variable')).not.toBeNull()
    expect(commandCell?.querySelector('.hljs-comment')).not.toBeNull()
    // Inline leaves share the parent's line box; no block/flex wrapper per token.
    for (const leaf of commandCell?.children ?? []) {
      expect(leaf.tagName).toBe('SPAN')
      expect(leaf.getAttribute('style')).toBeNull()
      expect(leaf.className).toMatch(/^(hljs-[\w-]+)?$/)
    }
  })

  it('unfolds and highlights the exact captured multiline command, leaving output plain', () => {
    const command = 'echo "$HOME"\nprintf "%s" "<script>alert(1)</script>"'
    mount({ toolInput: command, toolResult: '<b>plain output</b>' })
    expect(host.querySelector('.tool-cmd')?.textContent).toBe('echo "$HOME"')
    unfold()
    const full = host.querySelector('pre.tool-cmd')
    expect(full?.textContent).toBe(command)
    expect(full?.querySelector('.hljs-string')).not.toBeNull()
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('pre:not(.tool-cmd)')?.textContent).toBe('<b>plain output</b>')
    expect(host.querySelector('pre:not(.tool-cmd) span')).toBeNull()
  })

  it('keeps descriptions and non-Bash subjects plain and updates changed commands', () => {
    mount({ toolTitle: 'echo a description' })
    expect(host.querySelector('[class^="hljs-"]')).toBeNull()
    mount({ toolName: 'Read', toolInput: '"file.txt"' })
    expect(host.querySelector('[class^="hljs-"]')).toBeNull()
    mount({ toolInput: 'echo "first"' })
    expect(host.querySelector('.hljs-string')?.textContent).toBe('"first"')
    mount({ toolInput: 'echo "second"' })
    expect(host.querySelector('.hljs-string')?.textContent).toBe('"second"')
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe('echo "second"')
  })
})
