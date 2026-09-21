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

it('unfolds applied Bash effects with user modification and background metadata', () => {
  mount({
    toolInput: 'sed -i s/before/applied/ a.ts',
    toolResult: '',
    toolEffects: [
      {
        kind: 'file-edit',
        userModified: true,
        edit: {
          kind: 'file-edit',
          path: 'a.ts',
          mode: 'patch',
          hunks: [],
          patch: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-before\n+applied',
          added: 1,
          removed: 1,
          changedFileCount: 1,
        },
      },
      { kind: 'background-task', taskId: 'task-42' },
    ],
  })
  unfold()
  expect(host.textContent).toContain('applied diff')
  expect(host.textContent).toContain('User modified this edit')
  expect(host.textContent).toContain('1 file changed')
  expect(host.textContent).toContain('Background task: task-42')
})

it('shows an interrupted effect as a failure even with empty output', () => {
  mount({ toolResult: '', toolEffects: [{ kind: 'termination', interrupted: true }] })
  expect(host.querySelector('[data-verdict="err"]')).not.toBeNull()
  expect(host.textContent).toContain('Tool interrupted or timed out')
})

it('renders the real recorded Bash edit with identical path, hunk lines and counts', async () => {
  const { default: records } = await import(
    '../../../../../packages/harness/src/store/__fixtures__/claude-bash-edit.json'
  )
  const { claudeRecordToItems } = await import('@podium/harness/store')
  const { pairToolResults } = await import('./chat')
  const block = pairToolResults(records.flatMap(claudeRecordToItems))[0]
  if (!block) throw new Error('Missing recorded Bash call')
  const recordedCall = records[0]?.message.content[0]
  const command = recordedCall && 'input' in recordedCall ? recordedCall.input.command : undefined
  if (typeof command !== 'string') throw new Error('Missing recorded command')
  expect(command.length).toBeGreaterThan(160)
  expect(block.item.toolInput).toBe(`${command.slice(0, 160)}…`)
  mount({ ...block.item, toolResult: block.result })
  const collapsed = host.querySelector('.tool-row .tool-cmd')?.textContent ?? ''
  // The existing subject formatter also hides the leading cwd change.
  expect(collapsed).toMatch(/^cp .*…$/)
  expect(collapsed.length).toBeLessThanOrEqual(161)
  expect(collapsed).not.toContain('git log --oneline dev/mw..HEAD')
  expect(host.querySelector('pre.tool-cmd')).toBeNull()
  unfold()
  expect(host.querySelector('pre.tool-cmd')?.textContent).toBe(command)
  expect(host.textContent).not.toContain('Command truncated')
  expect(host.textContent).toContain('RESTORED clean')
  const recorded = records[1]?.toolUseResult?.bashEditDiff.files[0]
  if (!recorded) throw new Error('Missing recorded Bash effect')
  expect(host.textContent).toContain(recorded.filePath)
  for (const line of recorded.hunks[0]?.lines ?? []) {
    expect(host.textContent).toContain(line.slice(1))
  }
  expect(host.querySelector('.tool-edit-mag')?.textContent).toBe('+1 −1')
  expect(host.textContent).toContain('applied diff')
})

it('shows unavailable applied effects instead of requested edits', () => {
  mount({
    toolInputJson: JSON.stringify({
      kind: 'file-edit',
      mode: 'write',
      hunks: [{ newText: 'REQUESTED ONLY' }],
      added: 1,
      removed: 0,
    }),
    toolEffects: [
      {
        kind: 'file-edit',
        edit: {
          kind: 'file-edit',
          mode: 'patch',
          hunks: [],
          added: 0,
          removed: 0,
          unavailable: true,
        },
      },
    ],
  })
  unfold()
  expect(host.textContent).toContain('Applied diff unavailable')
  expect(host.textContent).not.toContain('REQUESTED ONLY')
})

describe('retained Bash command disclosure', () => {
  it.each([
    undefined,
    '{broken',
    JSON.stringify({ kind: 'file-edit' }),
    JSON.stringify({ kind: 'shell-command', command: 42 }),
  ])('explicitly falls back to the legacy command for unusable payload %s', (toolInputJson) => {
    mount({ toolInput: 'echo legacy', ...(toolInputJson === undefined ? {} : { toolInputJson }) })
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe('echo legacy')
    expect(host.textContent).not.toContain('Command truncated')
  })

  it('shows the retained prefix and loss notice when the mapper budget is exceeded', async () => {
    const { claudeToolCallItem } = await import('@podium/harness/store')
    const item = claudeToolCallItem({
      id: 'large',
      toolName: 'Bash',
      input: { command: `echo ${'x'.repeat(100_000)}` },
    })
    const payload = JSON.parse(item.toolInputJson ?? 'null')
    expect(payload.truncated).toBe(true)
    mount(item)
    expect(host.textContent).not.toContain('Command truncated')
    expect(host.querySelector('.tool-row .tool-cmd')?.textContent).toBe(item.toolInput)
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe(payload.command)
    expect(host.textContent).toContain('Command truncated — remaining text was not retained.')
  })

  it('uses a retained empty command even when a legacy preview exists', () => {
    mount({
      toolInput: 'legacy',
      toolInputJson: JSON.stringify({ kind: 'shell-command', command: '' }),
    })
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe('')
  })
})
