/**
 * THE MURMUR COLUMN (POD-2380, board Chat): tool folds, notes from other agents
 * and the live turn speak in one quiet line each, and a question an agent asked
 * the operator opens with Reply, which hands the note to the composer's reply.
 */
import type { TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { murmurClock, TranscriptList } from './TranscriptList'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../client/hooks', () => ({
  useUiState: () => ({ get: () => null, set: () => {}, subscribe: () => () => {} }),
}))
vi.mock('./ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})

afterEach(cleanup)

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
