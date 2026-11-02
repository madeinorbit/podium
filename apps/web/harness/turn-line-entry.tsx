/** Offline scenes for the approved POD-2304 turn line, through the shipping feed. */

import type { TurnPreview } from '@podium/client-core/conversation'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import {
  buildChatRows,
  type ChatActivity,
  isInteractiveTool,
  pairToolResults,
  type TranscriptSearchState,
  transcriptActivityFacts,
} from '@podium/client-core/values'
import { asSessionId, asUserId, type TranscriptItem } from '@podium/model/browser'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { TranscriptFeed } from '@/features/chat/TranscriptFeed'
import { createSidebarFixture } from '../test/sidebar-fixture'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
const sessionId = asSessionId('turn-line-harness')
const time = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 17, 14, seconds)).toISOString()
const say = (id: string, text: string, seconds: number, answer = false): TranscriptItem => ({
  id,
  role: 'assistant',
  text,
  ts: time(seconds),
  answer,
})
const command = (
  id: string,
  input: string,
  seconds: number,
  result?: string,
  durationMs?: number,
): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: input,
  ts: time(seconds),
  toolResult: result,
  durationMs,
})
const note = (id: string, body: string, seconds: number, question = false): TranscriptItem => ({
  id,
  role: 'user',
  ts: time(seconds),
  text: `[podium message ${id} · from issue:POD-2242 · to ${question ? 'the operator' : 'issue:POD-2289'}]\n${body}\n${question ? '[this is a question: answer the sender]\n' : ''}[end podium message ${id}]`,
})
const prompt: TranscriptItem = {
  id: 'prompt',
  role: 'user',
  text: 'Land POD-2242 once its checks pass.',
  ts: time(-5),
}
const work: TranscriptItem[] = [
  prompt,
  say('intro', "On it. First I'll check where POD-2242 stands.", 0),
  command('show', 'podium issue show POD-2242', 5, 'stage review\nparent main', 400),
  say('checking', "It's in review and based on main. Rebasing and running the checks now.", 20),
  command('rebase', 'git rebase main', 23, 'Successfully rebased.', 1200),
  {
    id: 'read',
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolInput: 'apps/web/src/styles.css',
    ts: time(27),
    toolResult: '.work-line { margin: 2px 0; }',
  },
  command('test', 'bun run test', 260),
  note('msg_status', 'Merge lock released\nmain is free again. POD-2240 landed.', 281),
  note(
    'msg_question',
    'whether inbox reads keep their own row\nWhich treatment do you prefer?',
    300,
    true,
  ),
]
const answer = say(
  'answer',
  'The checks are green and the branch is ready for review.\n\nThe turn stays on one line until you open it.',
  312,
  true,
)
const ask: TranscriptItem = {
  id: 'ask',
  role: 'tool',
  text: '',
  toolName: 'AskUserQuestion',
  ts: time(100),
  toolInputJson: JSON.stringify({
    questions: [
      {
        question: 'Which branch should I use?',
        header: 'Branch',
        options: [
          { label: 'main', description: 'Use the parent branch' },
          { label: 'dev', description: 'Use the development branch' },
        ],
      },
    ],
  }),
}
interface Scene {
  items: TranscriptItem[]
  activity: ChatActivity | null
  preview: TurnPreview | null
  query: string
  activeMatch: number | undefined
  activeRow: number | undefined
}
const initial: Scene =
  params.get('state') === 'short'
    ? {
        items: [
          prompt,
          say('intro', 'Let me check.', 0),
          command('show', 'podium issue show POD-2242', 1, 'stage review', 400),
          answer,
        ],
        activity: null,
        preview: null,
        query: '',
        activeMatch: undefined,
        activeRow: undefined,
      }
    : ['question', 'codex'].includes(params.get('state') ?? '')
      ? {
          items: [
            ...work.slice(0, 4),
            params.get('state') === 'codex'
              ? {
                  ...ask,
                  toolName: 'request_user_input',
                  toolInputJson: undefined,
                  toolTitle: 'Which branch should I use?',
                }
              : ask,
          ],
          activity: { tone: 'attention', label: 'needs answer' },
          preview: null,
          query: '',
          activeMatch: undefined,
          activeRow: undefined,
        }
      : params.get('state') === 'settled'
        ? {
            items: [
              ...work.map((item) =>
                item.id === 'test'
                  ? { ...item, toolResult: 'lean gate green', durationMs: 52000 }
                  : item,
              ),
              answer,
            ],
            activity: null,
            preview: null,
            query: '',
            activeMatch: undefined,
            activeRow: undefined,
          }
        : {
            items: work,
            activity: { tone: 'working', label: 'Working' },
            preview: null,
            query: '',
            activeMatch: undefined,
            activeRow: undefined,
          }
const noop = () => {}
function Harness() {
  const [scene, setScene] = useState(initial)
  const blocks = useMemo(() => pairToolResults(scene.items), [scene.items])
  const rows = useMemo(() => buildChatRows(blocks).map((row, index) => ({ row, index })), [blocks])
  const search: TranscriptSearchState = {
    matches: scene.query
      ? blocks.flatMap((block, index) =>
          block.item.text.includes(scene.query) || block.result?.includes(scene.query)
            ? [index]
            : [],
        )
      : [],
    activeRow: scene.activeRow,
    activeMatch: scene.activeMatch,
    position: 0,
    total: 0,
    filtering: !!scene.query,
  }
  const update = useCallback(
    (patch: Partial<Scene>) => setScene((current) => ({ ...current, ...patch })),
    [],
  )
  useEffect(() => {
    Object.assign(window, { turnLineHarness: { update, state: () => scene } })
  }, [scene, update])
  const finish = () =>
    update({
      items: [
        ...scene.items.map((item) =>
          item.id === 'test'
            ? {
                ...item,
                toolResult: 'typecheck cached\nstatic green\nboot 4 passed\nlean gate green',
                durationMs: 52000,
              }
            : item,
        ),
        answer,
      ],
      activity: null,
      preview: null,
    })
  return (
    <main
      style={{
        minHeight: '100vh',
        padding: 24,
        background: 'var(--background)',
        display: 'grid',
        justifyItems: 'center',
        alignContent: 'start',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
        <button type="button" data-testid="finish-turn" onClick={finish}>
          Finish turn
        </button>
        <button
          type="button"
          data-testid="append-update"
          onClick={() =>
            update({
              items: [
                ...scene.items,
                say(
                  `update-${scene.items.length}`,
                  'Checks pass and the merge lock is free, so the branch is ready.',
                  305,
                ),
              ],
            })
          }
        >
          Append narration
        </button>
        <button
          type="button"
          data-testid="stop-turn"
          onClick={() =>
            update({
              items: [
                ...scene.items,
                { id: 'stop', role: 'user', event: 'interrupt', text: '', ts: time(305) },
              ],
              activity: { tone: 'note', label: 'interrupted' } as never,
            })
          }
        >
          Interrupt
        </button>
        <button
          type="button"
          data-testid="fail-turn"
          onClick={() => update({ activity: { tone: 'error', label: 'rate limited' } })}
        >
          Fail turn
        </button>
      </div>
      <section
        data-turn-pane
        style={{
          width: Number(params.get('width') ?? 960),
          maxWidth: '100%',
          height: Number(params.get('height') ?? 680),
          display: 'flex',
          background: 'var(--chat-face)',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
        }}
      >
        <TranscriptFeed
          rows={rows}
          blocks={blocks}
          blockCount={blocks.length}
          setScrollerRef={noop}
          setContentRef={noop}
          onScroll={noop}
          onPointerUp={noop}
          compact={params.has('compact')}
          superagent={false}
          phase="ready"
          markdownHtml={new Map()}
          search={search}
          searchQuery={scene.query}
          moreAbove={false}
          loadingOlder={false}
          loadOlder={noop}
          sessionId={sessionId}
          cwd="/repo"
          session={
            {
              agentState: {
                phase: scene.activity?.tone === 'working' ? 'working' : 'needs_user',
                since: time(0),
              },
            } as never
          }
          httpOrigin="http://offline.invalid"
          openFile={noop}
          onOpenImage={noop}
          onAnswerAsk={async () =>
            update({
              items: [
                ...scene.items.map((item) =>
                  item.id === 'ask' ? { ...item, toolResult: 'main' } : item,
                ),
                say('resumed', 'Using main. Continuing the checks.', 110),
              ],
              activity: { tone: 'working', label: 'Working' },
            })
          }
          livePendingAskIndex={blocks.findLastIndex(
            (block) =>
              isInteractiveTool(block.item) &&
              block.result === undefined &&
              block.item.toolResult === undefined,
          )}
          pendingAskBlock={null}
          lastAnswerBlockIndex={blocks.findLastIndex((block) => block.item.answer)}
          collapseContext={false}
          stickyEnabled={false}
          isOperatorPromptRow={(row) =>
            row.kind === 'block' &&
            row.block.item.role === 'user' &&
            !row.block.item.event &&
            !transcriptActivityFacts(row.block.item).envelopes
          }
          onRetractQueued={async () => {}}
          activity={scene.activity}
          turnPreview={scene.preview}
          attribution={{} as never}
          onQuote={noop}
        />
      </section>
    </main>
  )
}
const root = document.getElementById('root')
if (root) {
  const fixture = createSidebarFixture(0, 0, true)
  createRoot(root).render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
      attachRuntime={(owner) =>
        attachWorklistPool(owner, (error) => {
          throw error
        })
      }
    >
      <Harness />
    </StoreProvider>,
  )
}
