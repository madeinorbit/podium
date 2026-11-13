/**
 * THE MURMUR COLUMN (POD-2380, board Chat): tool folds, notes from other agents
 * and the live turn speak in one quiet line each, and a question an agent asked
 * the operator opens with Reply, which hands the note to the composer's reply.
 */
import { renderMailPointer } from '@podium/commands/mail-pointer-nudge'
import type { TranscriptItem } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const markdownRenders = vi.hoisted(() => vi.fn())
const mailBody = vi.hoisted(() =>
  vi.fn((): { status: string; body?: string; retry?: () => void } => ({
    status: 'ready',
    body: 'The complete pointer body.',
  })),
)
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<object>()),
  useMailBody: mailBody,
}))

import { murmurClock, TranscriptList } from './TranscriptList'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => {
    markdownRenders(text)
    return <span>{text}</span>
  },
  RichMarkdownInline: ({ text }: { text: string }) => <>{text}</>,
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../client/hooks', () => ({
  useUiState: () => ({ get: () => null, set: () => {}, subscribe: () => () => {} }),
}))
vi.mock('./ActionSheet', () => ({
  ActionSheet: ({ visible, subtitle }: { visible: boolean; subtitle?: string }) =>
    visible ? <div data-testid="message-actions">{subtitle}</div> : null,
}))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({ children, head }: { children: React.ReactNode; head: React.ReactNode }) => (
    <div role="dialog">
      {head}
      {children}
    </div>
  ),
}))
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
beforeEach(() => {
  markdownRenders.mockClear()
  mailBody.mockReset()
  mailBody.mockReturnValue({ status: 'ready', body: 'The complete pointer body.' })
})

it('formats the murmur clock with the shared m:ss motion clock', () => {
  expect(murmurClock(12_000)).toBe('0:12')
  expect(murmurClock(195_000)).toBe('3:15')
  expect(murmurClock(3_725_000)).toBe('62:05')
  expect(murmurClock(undefined)).toBeUndefined()
  expect(murmurClock(-1)).toBeUndefined()
})

const running: TranscriptItem[] = [
  { id: 'say', role: 'assistant', text: 'Looking at the graph.', ts: '2026-11-10T10:00:00Z' },
  {
    id: 'read',
    role: 'tool',
    text: '',
    toolName: 'Read',
    toolInput: '/repo/transcript-graph.ts',
    ts: '2026-11-10T10:00:01Z',
  },
]

it('draws one live line for a working turn: the call in flight, not the tail too', () => {
  render(
    <TranscriptList
      items={running}
      live
      transcriptQuestion={null}
      onAnswer={async () => {}}
      tail={{ label: 'Working', tone: 'working', since: '2026-11-10T10:00:00Z' }}
    />,
  )
  const live = screen.getAllByLabelText(/work run:/)
  expect(live).toHaveLength(1)
  expect(live[0]?.getAttribute('aria-label')).toMatch(/Read/)
  // The tail steps aside while the run carries the live line.
  expect(screen.queryByLabelText('Working')).toBeNull()
})

it('keeps the tail as the live line while the agent writes after its tools', () => {
  render(
    <TranscriptList
      items={[...running, { id: 'after', role: 'assistant', text: 'Done reading.' }]}
      live
      transcriptQuestion={null}
      onAnswer={async () => {}}
      tail={{ label: 'Working', tone: 'working', since: '2026-11-10T10:00:00Z' }}
    />,
  )
  expect(screen.getByLabelText('Working')).toBeTruthy()
})

it('opens a question from another agent with Reply, which starts the reply', () => {
  const start = vi.fn()
  const mailReply = {
    active: false,
    target: null,
    start,
    load: vi.fn(async () => {}),
    message: () => undefined,
  }
  render(
    <TranscriptList
      items={[
        {
          id: 'ask',
          role: 'user',
          text: '[podium message msg_q · from issue:POD-1906 · to operator]\nShould the CSV move to the report?\n[this is a question: reply with podium mail reply msg_q]\n[end podium message msg_q]',
        },
      ]}
      live={false}
      transcriptQuestion={null}
      onAnswer={async () => {}}
      mailReply={mailReply as never}
    />,
  )
  const line = screen.getByLabelText(/^Open note from POD-1906: asked you a question/)
  expect(screen.queryByText(/Should the CSV move/)).toBeNull()
  fireEvent.click(line)
  expect(screen.getByText(/Should the CSV move/)).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Reply to POD-1906'))
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg_q' }))
})

it("names a fold by the harness's own summary of its calls", () => {
  render(
    <TranscriptList
      items={[
        {
          id: 'c1',
          role: 'tool',
          text: '',
          toolName: 'Bash',
          toolUseId: 'u1',
          toolInput: 'bun build',
        },
        {
          id: 'c2',
          role: 'tool',
          text: '',
          toolName: 'Read',
          toolUseId: 'u2',
          toolInput: '/r/chart.ts',
        },
        {
          id: 's',
          role: 'system',
          systemKind: 'tool-summary',
          text: 'Rebuilt the corpus and regenerated the chart',
          summarizes: ['u1', 'u2'],
        },
        { id: 'after', role: 'assistant', text: 'Done.' },
      ]}
      live={false}
      transcriptQuestion={null}
      onAnswer={async () => {}}
    />,
  )
  expect(
    screen.getByLabelText('Expand work run: Rebuilt the corpus and regenerated the chart'),
  ).toBeTruthy()
})

const transcript = (items: TranscriptItem[]) => (
  <TranscriptList items={items} live={false} transcriptQuestion={null} onAnswer={async () => {}} />
)
const note = (id: string, body: string, ask = false) =>
  `[podium message ${id} · from issue:POD-1906 · to ${ask ? 'operator' : 'issue:POD-1879'}]\n${body}\n${ask ? `[this is a question: reply with podium mail reply ${id}]\n` : ''}[end podium message ${id}]`

it('uses a first-line note subject and keeps the full markdown behind the fold', () => {
  render(
    transcript([
      { id: 'note', role: 'user', text: note('msg_n', '## **Ready**\nDetails on the next line.') },
    ]),
  )
  expect(screen.getByLabelText('Open note from POD-1906: Ready')).toBeTruthy()
  expect(screen.queryByText(/Details on/)).toBeNull()
  fireEvent.click(screen.getByLabelText('Open note from POD-1906: Ready'))
  expect(screen.getByText(/Details on/)).toBeTruthy()
})

it('does not load a pointer until its well opens, then uses the fetched body', () => {
  const text = renderMailPointer(1, [{ from: 'issue:POD-1906', ids: ['msg_pointer'] }])
  render(transcript([{ id: 'pointer', role: 'user', text }]))
  expect(mailBody).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText(/^Open note from POD-1906/))
  expect(mailBody).toHaveBeenCalledWith('msg_pointer')
  expect(screen.getByText('The complete pointer body.')).toBeTruthy()
})

it('shows a pointer read failure and retries from the opened well', () => {
  const retry = vi.fn()
  mailBody.mockReturnValue({ status: 'error', retry })
  render(
    transcript([
      {
        id: 'pointer',
        role: 'user',
        text: renderMailPointer(1, [{ from: 'issue:POD-1906', ids: ['msg_pointer'] }]),
      },
    ]),
  )
  fireEvent.click(screen.getByLabelText(/^Open note from POD-1906/))
  expect(screen.getByText('Could not load this message.')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Retry loading note'))
  expect(retry).toHaveBeenCalledOnce()
})

it('folds ordinary notes from one delivery but keeps an operator question separate', () => {
  render(
    transcript([
      {
        id: 'batch',
        role: 'user',
        text: [
          note('msg_a', 'First note'),
          note('msg_q', 'Need a choice?', true),
          note('msg_b', 'Second note'),
        ].join('\n'),
      },
    ]),
  )
  expect(screen.getByLabelText('Expand 2 notes')).toBeTruthy()
  expect(screen.getByLabelText(/^Open note from POD-1906: asked you a question/)).toBeTruthy()
  expect(screen.queryByLabelText('Open note from POD-1906: First note')).toBeNull()
  fireEvent.click(screen.getByLabelText('Expand 2 notes'))
  expect(screen.getByLabelText('Open note from POD-1906: First note')).toBeTruthy()
  expect(screen.getByLabelText('Open note from POD-1906: Second note')).toBeTruthy()
})

it('expands a call inline to six output lines and opens the rest in a sheet', async () => {
  const output = Array.from({ length: 9 }, (_, index) => `Output line ${index + 1}`).join('\n')
  render(
    transcript([
      {
        id: 'call',
        role: 'tool',
        text: '',
        toolName: 'Bash',
        toolInput: 'bun run test',
        toolResult: output,
      },
    ]),
  )
  fireEvent.click(screen.getByLabelText(/^Expand work run:/))
  expect(screen.queryByText(/Output line 1/)).toBeNull()
  fireEvent.click(screen.getByLabelText('Expand call: bun run test'))
  expect(screen.getByText(/Output line 6/)).toBeTruthy()
  expect(screen.queryByText(/Output line 7/)).toBeNull()
  fireEvent.click(screen.getByLabelText('Show all for bun run test'))
  expect((await screen.findByRole('dialog')).textContent).toContain('Output line 9')
})

it('shows recorded edit counts and the diff inside the opened call', () => {
  render(
    transcript([
      {
        id: 'edit',
        role: 'tool',
        text: '',
        toolName: 'Edit',
        toolTitle: 'Edited LoginScreen.tsx',
        toolInputJson: JSON.stringify({
          kind: 'file-edit',
          mode: 'replace',
          hunks: [{ oldText: 'old', newText: 'new\nmore' }],
          added: 2,
          removed: 1,
        }),
      },
    ]),
  )
  fireEvent.click(screen.getByLabelText(/^Expand work run:/))
  expect(screen.getByText('+2')).toBeTruthy()
  expect(screen.getByText('−1')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Expand call: Edited LoginScreen.tsx'))
  expect(screen.getByText(/−old/)).toBeTruthy()
  expect(screen.getByText(/\+new/)).toBeTruthy()
})

it('renders Codex/MCP asks as asks and compaction as a summary disclosure', () => {
  render(
    transcript([
      {
        id: 'ask',
        role: 'tool',
        text: '',
        toolName: 'mcp__codex__request_user_input',
        toolTitle: 'Choose a target',
        toolResult: 'Target chosen.',
      },
      {
        id: 'compact',
        role: 'system',
        systemKind: 'compaction',
        text: '## Summary\nKeep the corrected corpus.',
      },
    ]),
  )
  const ask = screen.getByLabelText(/^Needs your input/)
  expect(screen.queryByText('Target chosen.')).toBeNull()
  fireEvent.click(ask)
  expect(screen.getByText('Target chosen.')).toBeTruthy()
  expect(screen.queryByText(/Keep the corrected corpus/)).toBeNull()
  fireEvent.click(screen.getByLabelText('Context compacted · Show summary'))
  expect(screen.getByText(/Keep the corrected corpus/)).toBeTruthy()
})

it('centres one mark per day change without per-bubble clocks', () => {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const today = new Date()
  render(
    transcript([
      { id: 'one', role: 'user', text: 'Yesterday message', ts: yesterday.toISOString() },
      { id: 'two', role: 'assistant', text: 'Same day', ts: yesterday.toISOString() },
      { id: 'three', role: 'user', text: 'Today message', ts: today.toISOString() },
    ]),
  )
  expect(screen.getAllByText('Yesterday')).toHaveLength(1)
  expect(screen.getAllByText('Today')).toHaveLength(1)
  expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull()
})

it('updates a day label at midnight without rendering message prose again', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 13, 23, 59, 30))
  const ts = new Date().toISOString()
  render(
    transcript([
      { id: 'one', role: 'assistant', text: 'Earlier today', ts },
      { id: 'two', role: 'assistant', text: 'Still today', ts },
    ]),
  )
  expect(screen.queryByText('Yesterday')).toBeNull()
  const renders = markdownRenders.mock.calls.length
  act(() => {
    vi.advanceTimersByTime(61_000)
  })
  expect(screen.getByText('Yesterday')).toBeTruthy()
  expect(markdownRenders).toHaveBeenCalledTimes(renders)
})

it('keeps a failed edit visible while its recorded diff is expanded', () => {
  render(
    transcript([
      {
        id: 'failed-edit',
        role: 'tool',
        text: '',
        toolName: 'Edit',
        toolTitle: 'Edited LoginScreen.tsx',
        toolResult: 'Error: the target text was not found',
        toolInputJson: JSON.stringify({
          kind: 'file-edit',
          mode: 'replace',
          hunks: [{ oldText: 'old', newText: 'new' }],
          added: 1,
          removed: 1,
        }),
      },
    ]),
  )
  fireEvent.click(screen.getByLabelText(/^Expand work run:/))
  fireEvent.click(screen.getByLabelText('Expand call: Edited LoginScreen.tsx'))
  expect(screen.getByText(/target text was not found/)).toBeTruthy()
  expect(screen.getByText(/−old/)).toBeTruthy()
})
