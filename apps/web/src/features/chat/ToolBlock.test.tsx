import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { presentToolBlock } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolBlock } from './ToolBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const editWork = vi.hoisted(() => ({ resolve: 0, lines: 0 }))
vi.mock('@podium/client-core/values', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/values')>()
  return {
    ...actual,
    resolveToolEdit: (...args: Parameters<typeof actual.resolveToolEdit>) => {
      editWork.resolve += 1
      return actual.resolveToolEdit(...args)
    },
    toolEditLines: (...args: Parameters<typeof actual.toolEditLines>) => {
      editWork.lines += 1
      return actual.toolEditLines(...args)
    },
  }
})

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
        // Blocks reach the row through the compute path, which precomputes
        // what the row lists (POD-2146).
        block={presentToolBlock({
          item: { id: 'bash', role: 'tool', text: '', toolName: 'Bash', ...input },
        })}
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
  it('keeps the full command in one quiet mono line with no tool-name column', () => {
    const command = `echo "$HOME" ${'"a long argument" '.repeat(40)}# final comment`
    mount({ toolInput: command })
    const row = host.querySelector('.work-line-row')
    const commandCell = host.querySelector('.work-line-code')
    expect(commandCell?.parentElement).toBe(row)
    expect(commandCell?.classList.contains('work-line-phrase')).toBe(true)
    expect(commandCell?.textContent).toBe(command)
    expect(row?.querySelectorAll(':scope > .work-line-code')).toHaveLength(1)
    expect(row?.querySelector('[class^="hljs-"]')).toBeNull()
    expect(row?.querySelector('.tool-name')).toBeNull()
  })

  it('unfolds and highlights the exact captured multiline command, leaving output plain', () => {
    const command = 'echo "$HOME"\nprintf "%s" "<script>alert(1)</script>"'
    mount({ toolInput: command, toolResult: '<b>plain output</b>' })
    expect(host.querySelector('.work-line-code')?.textContent).toBe('echo "$HOME"')
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
    expect(host.querySelector('.work-line-code')?.textContent).toBe('echo "first"')
    mount({ toolInput: 'echo "second"' })
    expect(host.querySelector('.work-line-code')?.textContent).toBe('echo "second"')
    unfold()
    expect(host.querySelector('.work-line-code')?.textContent).toBe('echo "second"')
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
  // Read off the module graph (readFileSync, not import): the fixture is JSON
  // data, not a capability, and a web test may not take the host barrel to
  // reach it (POD-4471: fixtures stay under the store as test-only data while
  // the grammar lives in the claude adapter, resolved here through the static
  // metadata projection).
  const records = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../../../packages/harness/src/store/__fixtures__/claude-bash-edit.json',
      ),
      'utf8',
    ),
  ) as Array<{
    message: { content: Array<{ input?: { command?: unknown } }> }
    toolUseResult?: {
      bashEditDiff: {
        files: Array<{ filePath: string; hunks: Array<{ lines: string[] }> }>
      }
    }
  }>
  const { transcriptRecordMapperFor } = await import('@podium/harness/metadata')
  const claudeRecordToItems = transcriptRecordMapperFor('claude-code')
  if (!claudeRecordToItems) throw new Error('claude-code grammar missing')
  const { pairToolResults } = await import('./chat')
  const block = pairToolResults(records.flatMap(claudeRecordToItems))[0]
  if (!block) throw new Error('Missing recorded Bash call')
  const recordedCall = records[0]?.message.content[0]
  const command = recordedCall && 'input' in recordedCall ? recordedCall.input?.command : undefined
  if (typeof command !== 'string') throw new Error('Missing recorded command')
  expect(command.length).toBeGreaterThan(160)
  expect(block.item.toolInput).toBe(`${command.slice(0, 160)}…`)
  mount({ ...block.item, toolResult: block.result })
  const collapsed =
    host.querySelector('.execution-command-preview')?.textContent?.slice(1, -1) ??
    host.querySelector('.work-line-row .work-line-code')?.textContent ??
    ''
  // The existing subject formatter also hides the leading cwd change.
  expect(collapsed).toBe(command.split('\n')[0])
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
    expect(host.querySelector('.work-line-code')?.textContent).toBe('echo legacy')
    expect(host.textContent).not.toContain('Command truncated')
  })

  it('shows the retained prefix and loss notice when the mapper budget is exceeded', async () => {
    const { transcriptRecordMapperFor } = await import('@podium/harness/metadata')
    const parse = transcriptRecordMapperFor('claude-code')
    if (!parse) throw new Error('claude-code grammar missing')
    // Build through the adapter grammar (not the item constructor): the mapper
    // applies the same input budgets the live tail does.
    const item = parse({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'large',
            name: 'Bash',
            input: { command: `echo ${'x'.repeat(100_000)}` },
          },
        ],
      },
    }).find((i) => i.role === 'tool')
    if (!item) throw new Error('Missing mapped Bash call')
    const retained = item.toolExecution?.inputs?.[0]
    expect(retained?.capture).toBe('truncated')
    mount(item)
    expect(host.textContent).not.toContain('Command truncated')
    expect(host.querySelector('.work-line-row .work-line-code')?.textContent).toBe(retained?.text)
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe(retained?.text)
    expect(host.textContent).toContain('Command truncated — remaining text was not retained.')
  })

  it('uses a retained empty command even when a legacy preview exists', () => {
    mount({
      toolInput: 'legacy',
      toolExecution: {
        kind: 'commands',
        inputs: [{ kind: 'command', toolName: 'Bash', text: '', capture: 'complete' }],
      },
    })
    unfold()
    expect(host.querySelector('pre.tool-cmd')?.textContent).toBe('')
  })
})

it('defers folded edit-body work across streamed results and unfolds the latest edit', () => {
  const input = (newText: string) =>
    JSON.stringify({
      kind: 'file-edit',
      path: 'a.ts',
      mode: 'replace',
      hunks: [{ oldText: 'before', newText }],
      added: 1,
      removed: 1,
    })
  const toolInputJson = input('after')
  editWork.resolve = 0
  editWork.lines = 0
  mount({ toolName: 'Edit', toolInput: 'a.ts', toolInputJson })
  const mountWork = { ...editWork }
  const frames = []
  for (let token = 0; token < 5; token++) {
    const before = { ...editWork }
    mount({
      toolName: 'Edit',
      toolInput: 'a.ts',
      toolInputJson: input(`after ${token}`),
      toolResult: `ok ${token}`,
    })
    frames.push({
      resolve: editWork.resolve - before.resolve,
      lines: editWork.lines - before.lines,
    })
  }
  expect(host.querySelector('[data-testid="tool-edit-diff"]')).toBeNull()
  expect(editWork).toEqual({ resolve: 0, lines: 0 })
  const folded = { ...editWork }
  unfold()
  expect(host.querySelector('[data-testid="tool-edit-diff"]')?.textContent).toContain('after 4')
  expect(editWork.lines - folded.lines).toBe(1)
  console.log(
    '[folded tool edit-body work]',
    JSON.stringify({
      mount: mountWork,
      frames,
      unfold: { resolve: editWork.resolve - folded.resolve, lines: editWork.lines - folded.lines },
    }),
  )
})

describe('script execution rows', () => {
  const script = (commands: string[], toolResult: string): Partial<TranscriptItem> => ({
    toolName: 'Script',
    toolExecution: {
      kind: 'commands',
      inputs: commands.map((text) => ({
        kind: 'command',
        toolName: 'Bash',
        text,
        capture: 'complete',
      })),
      output: { capture: 'complete' },
    },
    toolResult,
  })
  it('shows every full command and a single adjacent owned output section', () => {
    mount(script(['git diff --stat', 'git status --short'], '1 file changed'))
    expect(host.querySelector('.execution-title')?.textContent).toBe('Run2 commands')
    expect(host.querySelector('pre')).toBeNull()
    unfold()
    expect(
      [...host.querySelectorAll('.execution-command')].map((line) => line.textContent),
    ).toEqual(['git diff --stat', 'git status --short'])
    expect(host.querySelectorAll('.execution-output')).toHaveLength(1)
    expect(host.querySelector('.execution-output')?.parentElement).toBe(
      host.querySelector('.execution-inputs')?.parentElement,
    )
    expect(host.querySelector('.execution-output-text')?.textContent).toBe('1 file changed')
    expect(host.querySelectorAll('.execution-input button[aria-expanded]')).toHaveLength(0)
  })
  it('keeps a proven mail note scoped to its input while retaining the full command', () => {
    const send = "podium issue mail send POD-2128 --body 'Ready for review'"
    mount(script(['git status', send], 'mail DELIVERED to POD-2128 (msg_9) — confirmed'))
    unfold()
    expect(host.querySelector('.execution-input-description')?.textContent).toBe(
      'Note to POD-2128 · Ready for review',
    )
    expect(
      [...host.querySelectorAll('.execution-command')].map((line) => line.textContent),
    ).toEqual(['git status', send])
  })
  it('does not treat an unsuccessful send as a delivered note', () => {
    const send = "podium issue mail send POD-2128 --body 'Ready for review'"
    mount(
      script(
        ['git status', send],
        'Script failed\nOutput:\nmail DELIVERED to POD-2128 (msg_9) — confirmed',
      ),
    )
    // The normalized adapter's outcome is the authority when it supplies one.
    mount({
      ...script(['git status', send], 'mail DELIVERED to POD-2128 (msg_9) — confirmed'),
      toolExecution: { ...script(['git status', send], '').toolExecution, status: 'failed' },
    })
    unfold()
    expect(host.querySelector('.execution-input-description')).toBeNull()
    expect(host.querySelector('[data-verdict="err"]')).not.toBeNull()
  })
})

it('shows a command description once, keeps the full command and honest capture cues', () => {
  mount({
    toolInput: 'preview',
    toolExecution: {
      kind: 'commands',
      inputs: [
        {
          kind: 'command',
          toolName: 'Bash',
          text: 'git status --short',
          description: 'Inspect the working tree',
          capture: 'complete',
        },
      ],
    },
  })
  expect(host.querySelector('.execution-title')?.textContent).toBe(
    'Inspect the working tree (git status --short)',
  )
  expect(host.querySelector('.execution-output-cue')?.textContent).toBe('Output unavailable')
  unfold()
  expect(host.querySelectorAll('.execution-description')).toHaveLength(1)
  expect(host.querySelector('.execution-input-description')).toBeNull()
  expect(host.querySelector('.execution-command')?.textContent).toBe('git status --short')
  expect(host.querySelector('.execution-empty-output')?.textContent).not.toContain(
    'No output was returned',
  )
})

it('expands only retained output, supports wrapping and copies complete retained text', async () => {
  const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}: retained output`).join('\n')
  const writeText = vi.fn().mockResolvedValue(undefined)
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    mount({
      toolInput: 'some command',
      toolResult: text,
      toolExecution: { output: { capture: 'truncated' } },
    })
    unfold()
    expect(host.querySelector('.execution-more')?.textContent).toContain(
      'Showing 8 of 15 retained lines',
    )
    expect(host.querySelector('.execution-output-text')?.textContent).not.toContain('line 15:')
    act(() => host.querySelector<HTMLButtonElement>('.execution-more')?.click())
    expect(host.querySelector('.execution-output-text')?.textContent).toBe(text)
    act(() => host.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click())
    expect(host.querySelector('.execution-output')?.getAttribute('data-wrap')).toBe('true')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Copy retained output"]')?.click(),
    )
    expect(writeText).toHaveBeenCalledWith(text)
    expect(host.textContent).toContain('Only the retained text is available')
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('renders a real Codex script adapter result with one clean owned output', async () => {
  const { transcriptRecordMapperFor } = await import('@podium/harness/metadata')
  const parse = transcriptRecordMapperFor('codex')!
  const records = [
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'outer',
        input:
          'await Promise.all([tools.exec_command({cmd:"pwd"}), tools.exec_command({cmd:"git status --short"})])',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'outer',
        output:
          'Script completed\nWall time: 0.2 seconds\nOutput:\n{"exit_code":1,"output":"printed data"}',
      },
    },
  ]
  const { pairToolResults } = await import('./chat')
  const block = pairToolResults(records.flatMap(parse))[0]!
  mount({ ...block.item, toolResult: block.result })
  expect(host.querySelector('.execution-title')?.textContent).toBe('Run2 commands')
  unfold()
  expect(host.querySelectorAll('.execution-command')).toHaveLength(2)
  expect(host.querySelectorAll('.execution-output')).toHaveLength(1)
  expect(host.querySelector('.execution-output-text')?.textContent).toBe(
    '{"exit_code":1,"output":"printed data"}',
  )
  expect(host.querySelector('.execution-status')?.textContent).toBe('Completed')
  expect(host.querySelector('.execution-output')?.textContent).not.toContain('Wall time')
})

it('uses a neutral tool label for an opaque script and retains its source behind disclosure', () => {
  mount({
    toolName: 'Script',
    toolExecution: {
      kind: 'actions',
      inputs: [
        {
          kind: 'tool',
          toolName: 'Script',
          text: 'const privateImplementation = 1;\ntext(privateImplementation)',
          capture: 'complete',
        },
      ],
    },
  })
  expect(host.querySelector('.execution-title')?.textContent).toBe('Script')
  expect(host.textContent).not.toContain('privateImplementation')
  unfold()
  expect(host.querySelector('.execution-command')?.textContent).toContain(
    'const privateImplementation = 1;',
  )
})
