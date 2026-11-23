/** Shipping command components, exercised with adapter-normalized facts. */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { TranscriptGraph } from '@podium/client-core/conversation'
import {
  asSessionId,
  type TranscriptExecutionInput,
  type TranscriptItem,
} from '@podium/model/browser'
import {
  ArrowUp,
  ChevronDown,
  GitBranch,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolBatchView } from '@/features/chat/ToolBatchView'
import { CommandExecutionFeed } from './command-execution-feed'
import '@/index.css'
import '@/styles.css'
import './command-execution.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const input = (text: string, description?: string): TranscriptExecutionInput => ({
  kind: 'command',
  toolName: 'Bash',
  text,
  description,
  capture: 'complete',
})
function call(
  id: string,
  inputs: TranscriptExecutionInput[],
  result: string | undefined,
  options: {
    batch?: string
    capture?: 'complete' | 'truncated' | 'unavailable'
    failed?: boolean
    duration?: number
  } = {},
): TranscriptItem {
  return {
    id,
    role: 'tool',
    text: '',
    toolName: inputs.length > 1 ? 'Script' : 'Bash',
    toolUseId: id,
    toolInput: inputs[0]?.text.slice(0, 160),
    ts: `2026-11-16T10:41:${id === 'inspect' ? '05' : id === 'check' ? '19' : '31'}Z`,
    ...(result !== undefined ? { toolResult: result } : {}),
    ...(options.batch ? { toolBatch: { id: options.batch, kind: 'message' } } : {}),
    toolExecution: {
      kind: 'commands',
      inputs,
      status: options.failed ? 'failed' : result !== undefined ? 'completed' : undefined,
      durationMs: options.duration ?? 320,
      ...(options.failed ? { exitCode: 1 } : {}),
      ...(result !== undefined ? { output: { capture: options.capture ?? 'complete' } } : {}),
    },
  }
}
const scenes = {
  codex: new TranscriptGraph([
    call(
      'inspect',
      [
        input('git status --short'),
        input('rg -n "ToolBatchView|ToolBlock" apps/web/src/features/chat'),
        input("sed -n '80,145p' apps/web/src/features/chat/ToolBlock.tsx"),
      ],
      ' M apps/web/src/features/chat/ToolBlock.tsx\n M apps/web/src/features/chat/ToolBatchView.tsx\n\napps/web/src/features/chat/ToolBatchView.tsx:142:export const ToolBatchView = observer(\napps/web/src/features/chat/ToolBlock.tsx:34:export function ToolBlock(props: ToolBlockProps) {\n  const execution = props.block.execution\n  return execution ? <CommandExecutionBlock {...props} execution={execution} /> : …\n}',
      { duration: 820 },
    ),
    call(
      'check',
      [input('bun run test:file -- packages/client-core/src/values/tool-execution.test.ts')],
      '✓ shared execution presentation (5 tests)\n\nTest Files  1 passed (1)\n     Tests  5 passed (5)',
      { duration: 3150 },
    ),
    call('quiet', [input('git diff --check')], '', { duration: 120 }),
    call('missing', [input('bun run build')], undefined),
  ]),
  claude: new TranscriptGraph([
    call(
      'inspect',
      [input('git status --short', 'Check the working tree')],
      ' M apps/web/src/features/chat/ToolBlock.tsx\n M apps/web/src/features/chat/ToolBatchView.tsx',
      { batch: 'step-one', duration: 260 },
    ),
    call(
      'check',
      [
        input(
          'rg -n "toolExecution" packages/client-core/src/conversation',
          'Find execution derivations',
        ),
      ],
      'packages/client-core/src/conversation/transcript-graph.ts:202:withToolResult(item, result)\npackages/client-core/src/conversation/transcript-tool-run.ts:158:block.execution',
      { batch: 'step-one', duration: 350 },
    ),
    {
      id: 'summary',
      role: 'system',
      text: 'Inspect command rendering and transcript derivations',
      systemKind: 'tool-summary',
      summarizes: ['inspect', 'check'],
    },
    call('quiet', [input('git diff --check', 'Check whitespace')], '', {
      batch: 'step-two',
      duration: 90,
    }),
  ]),
  states: new TranscriptGraph([
    call('empty', [input('true', 'Confirm a quiet command')], ''),
    call(
      'partial',
      [
        input(
          'bun run test:file -- packages/harness/src/adapters/shared/execution-conformance.test.ts',
        ),
      ],
      Array.from(
        { length: 18 },
        (_, i) => `  ✓ execution ownership case ${String(i + 1).padStart(2, '0')} passed`,
      ).join('\n'),
      { capture: 'truncated', duration: 2700 },
    ),
    call(
      'failed',
      [input('bun run check', 'Validate the change')],
      'Check failed: expected a closing tag\n  at src/example.tsx:18\n\n1 check failed.',
      { failed: true, duration: 180 },
    ),
    call('unavailable', [input('a-command-without-retained-text')], '', { capture: 'unavailable' }),
  ]),
}
function App() {
  const [scene, setScene] = useState<keyof typeof scenes>(
    (params.get('scene') as keyof typeof scenes) in scenes
      ? (params.get('scene') as keyof typeof scenes)
      : 'codex',
  )
  const graph = scenes[scene],
    row = graph.structuralRows[0]!
  if (row.kind !== 'tools') throw new Error('Expected an execution run')
  return (
    <main className="command-harness">
      <nav className="command-harness-controls" aria-label="Transcript samples">
        {(['codex', 'claude', 'states'] as const).map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={scene === name}
            onClick={() => setScene(name)}
          >
            {name === 'states' ? 'Capture states' : name === 'codex' ? 'Codex' : 'Claude Code'}
          </button>
        ))}
        <button type="button" onClick={() => document.documentElement.classList.toggle('dark')}>
          Theme
        </button>
      </nav>
      <section className="command-harness-panel">
        <header className="command-harness-tab">
          <SquareTerminal size={13} />
          <span>Unified command transcript</span>
          <X size={12} />
        </header>
        <div className="command-harness-toolbar">
          <GitBranch size={12} />
          <span>command-transcript</span>
          <span className="command-harness-toolbar-spacer" />
          <MessageSquareText size={12} />
          <strong>Chat</strong>
          <SquareTerminal size={12} />
          <span>CLI</span>
          <MoreHorizontal size={15} />
        </div>
        <div className="command-harness-feed" data-feed-container>
          {params.get('surface') === 'stretch' ? (
            <div className="feed-column">
              <ToolBatchView
                key={scene}
                row={row}
                run={graph.run(row.blocks[0]!.item.id)}
                index={2}
                highlighted={false}
                dimmed={false}
                forceOpen={false}
                sessionId={asSessionId('execution-harness')}
                cwd="/workspace/project"
                openFile={() => {}}
              />
            </div>
          ) : (
            <CommandExecutionFeed key={scene} graph={graph} />
          )}
        </div>
        <div className="command-harness-composer">
          <div className="chat-composer-well">
            <div>Message {scene === 'claude' ? 'Claude Code' : 'Codex'}…</div>
            <div className="command-harness-composer-tools">
              <span>
                Default model <ChevronDown size={10} />
              </span>
              <Paperclip size={15} />
              <ArrowUp size={15} />
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
