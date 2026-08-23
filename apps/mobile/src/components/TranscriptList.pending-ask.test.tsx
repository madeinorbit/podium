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
import { Suspense, act, startTransition, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const markdownRenders = vi.hoisted(() => new Map<string, number>())

afterEach(() => {
  cleanup()
  markdownRenders.clear()
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => {
    markdownRenders.set(text, (markdownRenders.get(text) ?? 0) + 1)
    return <span>{text}</span>
  },
}))
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

  it('keeps settled markdown rows out of live-text rerenders', () => {
    const settled = { id: 'settled', role: 'assistant' as const, text: 'Settled answer' }
    const { rerender } = render(
      <TranscriptList
        items={[settled, { id: 'super:live', role: 'assistant', text: 'Live one' }]}
        live
        streaming
        onAnswer={async () => {}}
      />,
    )

    rerender(
      <TranscriptList
        items={[settled, { id: 'super:live', role: 'assistant', text: 'Live two' }]}
        live
        streaming
        onAnswer={async () => {}}
      />,
    )

    expect(markdownRenders.get('Settled answer')).toBe(1)
    expect(markdownRenders.get('Live one')).toBe(1)
    expect(markdownRenders.get('Live two')).toBe(1)
  })

  it('routes a memoized question row to the latest committed answer handler', async () => {
    const ask = fromState()
    const first = vi.fn(async () => {})
    const latest = vi.fn(async () => {})
    const { rerender } = render(
      <TranscriptList items={[]} live pendingAsk={ask} onAnswer={first} />,
    )

    rerender(<TranscriptList items={[]} live pendingAsk={ask} onAnswer={latest} />)
    fireEvent.click(screen.getByLabelText('SQLite'))

    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1))
    expect(first).not.toHaveBeenCalled()
  })

  it('does not leak a handler from a suspended concurrent render', async () => {
    const ask = fromState()
    const committed = vi.fn(async () => {})
    const abandoned = vi.fn(async () => {})
    const suspended = new Promise<never>(() => {})
    let attempted = false
    let beginAbandonedRender: (() => void) | undefined

    function SuspendAfterTranscript({ blocked }: { blocked: boolean }) {
      if (blocked) {
        attempted = true
        throw suspended
      }
      return null
    }

    function ConcurrentHarness() {
      const [answer, setAnswer] = useState(() => committed)
      const [blocked, setBlocked] = useState(false)
      beginAbandonedRender = () => {
        startTransition(() => {
          setAnswer(() => abandoned)
          setBlocked(true)
        })
      }
      return (
        <Suspense fallback={null}>
          <TranscriptList items={[]} live pendingAsk={ask} onAnswer={answer} />
          <SuspendAfterTranscript blocked={blocked} />
        </Suspense>
      )
    }

    render(<ConcurrentHarness />)
    act(() => beginAbandonedRender?.())
    expect(attempted).toBe(true)

    fireEvent.click(screen.getByLabelText('Postgres'))

    await waitFor(() => expect(committed).toHaveBeenCalledTimes(1))
    expect(abandoned).not.toHaveBeenCalled()
  })
})
