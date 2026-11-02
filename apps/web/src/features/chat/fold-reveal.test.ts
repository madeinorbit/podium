import { TranscriptLog } from '@podium/client-core/conversation'
import type { ChatRow } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationPresentation, RENDER_WINDOW } from './conversation-presentation'
import { revealFoldedRow } from './fold-reveal'

// A MINIMAP JUMP INTO A CLOSED FOLD (POD-2285) against a transcript longer than
// the reading window, with a delivery landing while the jump waits for layout.

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

const isPrompt = (row: ChatRow) =>
  row.kind === 'block' && row.block.item.role === 'user' && !row.block.item.event
const turn = (n: number): TranscriptItem[] => [
  { id: `p${n}`, role: 'user', text: `prompt ${n}` },
  { id: `u${n}`, role: 'assistant', text: `update ${n}` },
  {
    id: `t${n}`,
    role: 'tool',
    text: '',
    toolName: 'Bash',
    toolInput: 'ls',
    toolUseId: `use-${n}`,
    toolResult: 'ok',
  },
  { id: `a${n}`, role: 'assistant', text: `answer ${n}`, answer: true },
]

function fixture(items: TranscriptItem[]) {
  const client = {
    usesWorker: false,
    computeGraphOnMain(
      source: { sent(): void; graph: { search(q: string, c: number): unknown } },
      query: string,
      cursor: number,
    ) {
      source.sent()
      return { search: source.graph.search(query, cursor), markdownHtml: new Map() }
    },
    forgetGraph() {},
  }
  const presentation = new ConversationPresentation(client as never, isPrompt)
  const log: TranscriptLog = new TranscriptLog({
    sessionId: asSessionId('fold-reveal'),
    source: { read: async () => ({ items: log.items, hasMore: false }), subscribe: () => () => {} },
    cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
    retainHistory: () => presentation.retainHistory,
    onChange: (change) => presentation.changed(change),
  })
  presentation.bind(log)
  stops.push(() => {
    presentation.dispose()
    log.dispose()
  })
  return { presentation, log }
}

function setup() {
  const { presentation, log } = fixture(Array.from({ length: 100 }, (_, n) => turn(n)).flat())
  expect(presentation.rowCount).toBeGreaterThan(RENDER_WINDOW)
  presentation.folds.prime()
  // The fold whose work is the window's first row: where a slide hurts most.
  const target = presentation.turnFolds.folds.find(
    (fold) => fold.members[0]! >= presentation.renderStart,
  )!
  const index = target.members[0]!
  const frames: { id: number; callback: () => void }[] = []
  const cancelled = new Set<number>()
  let next = 0
  const calls: string[] = []
  const scroll = {
    // The controller's release reaches the presentation through onFollowChange.
    releaseFollow: vi.fn(() => {
      calls.push('release')
      presentation.setFollowTail(false)
    }),
    scrollToBlock: vi.fn((at: number) => {
      calls.push(`scroll ${at}`)
    }),
  }
  const ports = {
    presentation,
    scroll,
    frame: (callback: () => void) => {
      frames.push({ id: ++next, callback })
      return next
    },
    cancelFrame: (id: number) => {
      cancelled.add(id)
    },
  }
  const flush = () => {
    while (frames.length) {
      const { id, callback } = frames.shift()!
      if (!cancelled.has(id)) callback()
    }
  }
  return { presentation, log, target, index, ports, scroll, calls, flush }
}

it('releases following before it waits, holds the window through a delivery, and lands on the row by key', () => {
  const { presentation, log, target, index, ports, calls, flush } = setup()
  const cancel = revealFoldedRow(ports, index)
  expect(cancel).toBeDefined()
  expect(calls).toEqual(['release'])
  expect(presentation.folds.opened.has(target.key)).toBe(true)
  // A prompt lands while the jump waits for layout.
  log.merge([...log.items, { id: 'late', role: 'user', text: 'one more thing' }])
  flush()
  // The window held its place, so the row is still mounted where it was asked for.
  expect(presentation.renderStart).toBeLessThanOrEqual(index)
  expect(calls).toEqual(['release', `scroll ${presentation.anchorRow(target.memberKeys[0]!)}`])
  expect(presentation.anchorRow(target.memberKeys[0]!)).toBe(index)
})

it('does nothing for a row that is not folded', () => {
  const { presentation, ports, scroll } = setup()
  const prompt = presentation.turnFolds.folds[0]!.start - 1
  expect(revealFoldedRow(ports, prompt)).toBeUndefined()
  expect(scroll.scrollToBlock).not.toHaveBeenCalled()
})

it('lands nowhere once its owner cancels it', () => {
  const { index, ports, scroll, flush } = setup()
  const cancel = revealFoldedRow(ports, index)!
  cancel()
  flush()
  expect(scroll.scrollToBlock).not.toHaveBeenCalled()
})
