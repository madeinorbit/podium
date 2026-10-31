/** Murmur review scenes using the shipping row builder and activity renderers. */
import {
  buildChatRows,
  type ChatRow,
  pairToolResults,
  parseEnvelopeBatch,
} from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model/browser'
import { type JSX, type ReactNode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageEnvelopeGroup } from '@/features/chat/MessageEnvelopeGroup'
import { ToolBatchView } from '@/features/chat/ToolBatchView'
import '@/index.css'
import '@/styles.css'

const sessionId = asSessionId('murmur-harness')
const noop = (): void => {}
const clock = (time: string): string => `2026-10-28T${time}:00Z`
const command = (
  id: string,
  input: string,
  time: string,
  result = 'ok',
  durationMs?: number,
): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: input,
  ts: clock(time),
  toolResult: result,
  durationMs,
})
const note = (
  id: string,
  from: string,
  body: string,
  time: string,
  question = false,
  to = 'issue:POD-2287',
): TranscriptItem => ({
  id,
  role: 'user',
  ts: clock(time),
  text: `[podium message ${id} · from ${from} · to ${to}]\n${body}\n${question ? '[this is a question: answer the sender]\n' : ''}[end podium message ${id}]`,
})
const RUN: TranscriptItem[] = [
  command('show', 'podium issue show POD-2242', '17:14'),
  note(
    'merged',
    'system:steward',
    'Merge lock released\nmain is free again. POD-2240 landed at 6563204.',
    '17:15',
  ),
  note(
    'review',
    'system:steward',
    'Review requested on POD-2242\nThe fold change is ready.',
    '17:15',
  ),
  command('rebase', 'git rebase main', '17:16'),
  {
    id: 'file',
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolPaths: ['apps/web/src/styles.css'],
    ts: clock('17:16'),
    toolResult: '.work-line { margin: 2px 0; }',
  },
  note('green', 'system:steward', 'CI is green on main\nThe parent branch is ready.', '17:16'),
  command(
    'test',
    'bun run test',
    '17:17',
    'typecheck   ✓ cached\nstatic      ✓\nboot        4 passed\n\nlean gate green in 2m 08s',
    128000,
  ),
  note(
    'ready',
    'issue:POD-2242',
    'Rebased and ready to land\nTip is 98aad23. Can you take the merge lock?',
    '17:18',
    true,
  ),
  command('lock', 'podium merge-lock acquire main', '17:18'),
  command('land', 'podium issue action --kind merge', '17:18'),
]
const ASK = note(
  'ask',
  'issue:POD-2242',
  'whether inbox reads keep their own row\nThe current draft folds them with the surrounding commands. Which would you prefer?',
  '17:18',
  true,
  'the operator',
)
const rows = buildChatRows(pairToolResults([...RUN, ASK]))

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-transcript-row="" style={{ display: 'flow-root', position: 'relative' }}>
      {children}
    </div>
  )
}
function Prose({
  children,
  answer = false,
}: {
  children: ReactNode
  answer?: boolean
}): JSX.Element {
  return (
    <Shell>
      <div className={`transcript-row${answer ? '' : ' transcript-process-row'}`}>
        <div className={`transcript-body${answer ? ' transcript-answer' : ''}`}>
          <div className="chat-md">
            <p>{children}</p>
          </div>
        </div>
      </div>
    </Shell>
  )
}
function Activity({ row, index }: { row: ChatRow; index: number }): JSX.Element {
  const lone =
    row.kind === 'tools' && row.blocks.length === 1
      ? row.blocks[0]
      : row.kind === 'block'
        ? row.block
        : undefined
  const batch = lone?.item.role === 'user' ? parseEnvelopeBatch(lone.item.text) : null
  return (
    <Shell>
      {batch ? (
        <MessageEnvelopeGroup
          envelopes={batch.envelopes}
          className="transcript-row"
          rowKey={lone?.item.id}
          blockIndex={index}
          ts={lone?.item.ts}
          onBodyClick={noop}
        />
      ) : row.kind === 'tools' ? (
        <ToolBatchView
          row={row}
          index={index}
          highlighted={false}
          dimmed={false}
          forceOpen={false}
          sessionId={sessionId}
          cwd="/repo"
          openFile={noop}
        />
      ) : null}
    </Shell>
  )
}
function Pane({ scene, narrow = false }: { scene: string; narrow?: boolean }): JSX.Element {
  const pane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (scene !== 'opened' && scene !== 'narrow') return
    let details = 0
    const frame = requestAnimationFrame(() => {
      pane.current
        ?.querySelector<HTMLButtonElement>('[data-transcript-run-toggle][aria-expanded="false"]')
        ?.click()
      details = requestAnimationFrame(() => {
        if (scene === 'opened')
          pane.current
            ?.querySelector<HTMLButtonElement>('.mail-item-head[aria-expanded="false"]')
            ?.click()
        const command = [
          ...(pane.current?.querySelectorAll<HTMLButtonElement>('.tool-block > .work-line-row') ??
            []),
        ].find((button) => button.textContent?.includes('bun run test'))
        if (command?.getAttribute('aria-expanded') === 'false') command.click()
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(details)
    }
  }, [scene])
  return (
    <section
      ref={pane}
      data-scenario={scene}
      style={{ width: narrow ? 360 : 960, maxWidth: '100%' }}
    >
      <div style={{ marginBottom: 14, font: '11px var(--font-mono)', color: 'var(--text-dim)' }}>
        {scene === 'between'
          ? 'Between messages'
          : scene === 'narrow'
            ? 'Narrow pane · 360px'
            : `Busy stretch · ${scene}`}
      </div>
      <div
        data-feed-container=""
        style={{
          background: 'var(--chat-face)',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
        }}
      >
        <div
          className="feed-column"
          style={{ padding: '28px max(32px, calc((100% - 41rem) / 2)) 32px' }}
        >
          {scene !== 'opened' && scene !== 'narrow' && (
            <Shell>
              <div className="transcript-row transcript-you">
                <div className="transcript-you-bubble">
                  <div className="chat-md">
                    <p>Land POD-2242 once its checks pass.</p>
                  </div>
                </div>
              </div>
            </Shell>
          )}
          {scene === 'between' ? (
            <>
              <Prose>On it. First I'll check where it stands.</Prose>
              <Activity row={buildChatRows(pairToolResults([RUN[0]!]))[0]!} index={0} />
              <Prose>It's in review and based on main. Rebasing and running the checks now.</Prose>
              <Activity row={buildChatRows(pairToolResults([RUN[6]!]))[0]!} index={1} />
              <Activity row={buildChatRows(pairToolResults([RUN[1]!]))[0]!} index={2} />
              <Prose>Checks pass and the merge lock is free, so I'm landing it.</Prose>
            </>
          ) : (
            <>
              <Prose>On it. I'll rebase, run the checks and take the merge lock.</Prose>
              {(narrow ? buildChatRows(pairToolResults([...RUN.slice(5), ASK])) : rows).map(
                (row, index) => (
                  <Activity
                    key={row.kind === 'tools' ? row.blocks[0]!.item.id : row.block.item.id}
                    row={row}
                    index={index}
                  />
                ),
              )}
              <Prose answer>
                {narrow
                  ? 'Landed as 98aad23.'
                  : 'POD-2242 is on main as 98aad23. It left one question for you, about the inbox rows.'}
              </Prose>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
const state = params.get('state')
function Harness(): JSX.Element {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--background)',
        padding: '32px',
        display: 'grid',
        justifyItems: 'center',
        gap: 28,
      }}
    >
      {state ? (
        <Pane scene={state} narrow={state === 'narrow'} />
      ) : (
        <>
          <Pane scene="between" />
          <Pane scene="folded" />
          <Pane scene="opened" />
          <Pane scene="narrow" narrow />
        </>
      )}
    </main>
  )
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
