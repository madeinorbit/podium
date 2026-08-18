/**
 * THE QUESTION THAT IS NOT IN THE TRANSCRIPT YET, ON THE PHONE (POD-1273).
 *
 * Claude Code writes an AskUserQuestion into its transcript only once the call
 * RESOLVES, so for the whole time the agent is waiting the feed's own rows carry
 * nothing to answer. The caller hands the ask down from agent state instead and
 * the SAME card draws it at the tail — these cases are about that card being a
 * real answering surface, not a read-only echo of the state.
 */
import type { TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../client/hooks', () => ({
  useUiState: () => ({ get: () => null, set: () => {}, subscribe: () => () => {} }),
}))
// The long-press sheet reaches react-native-gesture-handler, whose native
// module has no host in this lane. Nothing here opens a sheet.
vi.mock('./ActionSheet', () => ({ ActionSheet: () => null }))
// Shared-file rows reach the authenticated-asset client (secure storage, the
// profile gate); no row here transfers a file.
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
// The tail's working mark draws with react-native-svg, whose native entry is
// Flow-typed source no transform in this lane parses (see WorkingMark.test).
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('lucide-react-native', () => ({
  ChevronDown: () => null,
  ChevronUp: () => null,
  Search: () => null,
  X: () => null,
}))

const { TranscriptList } = await import('./TranscriptList')
const { PENDING_ASK_ITEM_ID, pendingAskFromState } = await import('@podium/client-core/viewmodels')

/** What the caller passes down: exactly what agent state produces, not a hand
 *  written item — a shape that drifted from `pendingAskFromState` would render
 *  here and nowhere else. */
const fromState = (): TranscriptItem => {
  const ask = pendingAskFromState(
    {
      kind: 'question',
      interview: {
        questions: [
          { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
        ],
      },
    },
    'live',
    'needs_user',
    false,
  )
  if (!ask) throw new Error('fixture: agent state should carry a pending ask')
  return ask.item
}

describe('TranscriptList pendingAsk', () => {
  it('draws the state-carried question and answers it', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<TranscriptList items={[]} live pendingAsk={fromState()} onAnswer={onAnswer} />)

    expect(screen.getByText('Which database?')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('SQLite'))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [2] }] }),
    )
  })

  // The id is stable across restatements of the same wait so the card keeps its
  // React identity — a row keyed by anything that changed per tick would throw
  // away a half-made selection every time the state ticked.
  it('keys the row by the synthetic item id', () => {
    render(<TranscriptList items={[]} live pendingAsk={fromState()} onAnswer={async () => {}} />)

    expect(fromState().id).toBe(PENDING_ASK_ITEM_ID)
    expect(screen.getByLabelText('Postgres')).toBeTruthy()
  })

  // `live` tracks the PTY, and a session still `starting` has a real dialog open
  // in front of a real operator. The card the state drew answers either way.
  it('answers on a session that is not live yet', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<TranscriptList items={[]} live={false} pendingAsk={fromState()} onAnswer={onAnswer} />)

    fireEvent.click(screen.getByLabelText('Postgres'))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [1] }] }),
    )
  })

  it('shows nothing when the caller has no live question to pass', () => {
    render(<TranscriptList items={[]} live pendingAsk={null} onAnswer={async () => {}} />)

    expect(screen.queryByText('Which database?')).toBeNull()
  })
})
