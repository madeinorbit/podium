import type { TranscriptGraph } from '@podium/client-core/conversation'
import { asSessionId } from '@podium/model/browser'
import { TranscriptFeed, type TranscriptFeedProps } from '@/features/chat/TranscriptFeed'

const noop = () => {}
export function CommandExecutionFeed({ graph }: { graph: TranscriptGraph }) {
  const snapshot = graph.snapshot()
  const end = snapshot.blocks.length + 2
  const rows: TranscriptFeedProps['rows'] = [
    {
      index: 0,
      row: {
        kind: 'block',
        blockIndex: 0,
        block: {
          item: {
            id: 'prompt',
            role: 'user',
            text: 'Refine the command transcript so each execution is easy to inspect.',
          },
        },
      },
    },
    {
      index: 1,
      row: {
        kind: 'block',
        blockIndex: 1,
        block: {
          item: {
            id: 'intro',
            role: 'assistant',
            text: 'I’ll check the command rendering and transcript derivations, then verify the shared presentation.',
          },
        },
      },
    },
    ...snapshot.rows.map((row, index) => ({
      index: index + 2,
      row:
        row.kind === 'tools' ? { ...row, blockIndices: row.blockIndices.map((at) => at + 2) } : row,
    })),
    {
      index: 3,
      row: {
        kind: 'block',
        blockIndex: end,
        block: {
          item: {
            id: 'answer',
            role: 'assistant',
            answer: true,
            text: 'Each execution keeps its own inputs and recorded result.',
          },
        },
      },
    },
  ]
  return (
    <TranscriptFeed
      rows={rows}
      setScrollerRef={noop}
      setContentRef={noop}
      onScroll={noop}
      onPointerUp={noop}
      compact={false}
      superagent={false}
      phase="ready"
      markdownHtml={new Map()}
      search={{
        filtering: false,
        matches: [],
        activeMatch: undefined,
        activeRow: undefined,
        position: 0,
        total: 0,
      }}
      moreAbove={false}
      loadingOlder={false}
      loadOlder={noop}
      sessionId={asSessionId('execution-harness')}
      cwd="/workspace/project"
      session={undefined}
      httpOrigin="http://harness"
      openFile={noop}
      onOpenImage={noop}
      onAnswerAsk={async () => {}}
      livePendingAskIndex={-1}
      pendingAskBlock={null}
      lastAnswerBlockIndex={end}
      collapseContext={false}
      stickyEnabled={false}
      isOperatorPromptRow={(row) => row.kind === 'block' && row.block.item.role === 'user'}
      onRetractQueued={async () => {}}
      attribution={{} as never}
      activity={null}
    />
  )
}
