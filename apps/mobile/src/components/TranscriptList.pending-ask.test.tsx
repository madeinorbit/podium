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
import { act, type ComponentType, Suspense, startTransition, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const markdownRenders = vi.hoisted(() => new Map<string, number>())
const transcriptBuilds = vi.hoisted(() => vi.fn())
const viewportData = vi.hoisted(() => [] as unknown[])
const searchWork = vi.hoisted(() => ({
  enabled: false,
  rowReads: 0,
  blockReads: 0,
  matches: vi.fn(),
  positions: vi.fn(),
}))

afterEach(() => {
  cleanup()
  markdownRenders.clear()
  transcriptBuilds.mockClear()
  viewportData.length = 0
  searchWork.enabled = false
  searchWork.rowReads = 0
  searchWork.blockReads = 0
  searchWork.matches.mockClear()
  searchWork.positions.mockClear()
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('./TranscriptViewport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TranscriptViewport')>()
  const { createElement, forwardRef } = await import('react')
  const CapturingViewport = forwardRef<
    import('./TranscriptViewport.types').TranscriptViewportHandle,
    Record<string, unknown>
  >((props, ref) => {
    viewportData.push(props.data)
    return createElement(
      actual.TranscriptViewport as unknown as ComponentType<Record<string, unknown>>,
      { ...props, ref },
    )
  })
  return { ...actual, TranscriptViewport: CapturingViewport }
})
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => {
    markdownRenders.set(text, (markdownRenders.get(text) ?? 0) + 1)
    return <span>{text}</span>
  },
}))
vi.mock('../lib/transcript-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transcript-feed')>()
  return {
    ...actual,
    buildMobileTranscript: (...args: Parameters<typeof actual.buildMobileTranscript>) => {
      transcriptBuilds(args[0])
      const model = actual.buildMobileTranscript(...args)
      if (!searchWork.enabled) return model
      return {
        ...model,
        blocks: model.blocks.map((block) => ({
          ...block,
          item: {
            ...block.item,
            get text() {
              searchWork.blockReads++
              return block.item.text
            },
          },
        })),
        rows: model.rows.map((row) => ({
          ...row,
          get blockIndices() {
            searchWork.rowReads++
            return row.blockIndices
          },
        })),
      }
    },
    matchMobileTranscript: (...args: Parameters<typeof actual.matchMobileTranscript>) => {
      searchWork.matches(args[1])
      return actual.matchMobileTranscript(...args)
    },
    positionMobileTranscriptSearch: (
      ...args: Parameters<typeof actual.positionMobileTranscriptSearch>
    ) => {
      searchWork.positions(args[1])
      return actual.positionMobileTranscriptSearch(...args)
    },
  }
})
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

const { TranscriptList } = await import('./TranscriptList')
const { PENDING_ASK_ITEM_ID, pendingAskFromState } = await import('@podium/client-core/values')

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
  it('does no closed Find work and moves between matches without rereading history at 1x/4x', () => {
    const samples = []
    const onAnswer = async () => {}
    for (const scale of [1, 4] as const) {
      searchWork.enabled = true
      const items = Array.from(
        { length: 128 * scale },
        (_, index): TranscriptItem => ({
          id: `find:${index}`,
          role: 'assistant',
          text: [2, 5, 10].includes(index) ? `needle ${index}` : `Settled ${index}`,
        }),
      )
      const reset = () => {
        searchWork.rowReads = 0
        searchWork.blockReads = 0
        searchWork.matches.mockClear()
        searchWork.positions.mockClear()
      }
      reset()
      const { rerender, unmount } = render(
        <TranscriptList items={items} live={false} onAnswer={onAnswer} />,
      )
      expect(searchWork.rowReads).toBe(0)
      expect(searchWork.blockReads).toBe(0)
      reset()
      rerender(<TranscriptList items={[...items]} live={false} onAnswer={onAnswer} />)
      expect(searchWork.rowReads).toBe(0)
      expect(searchWork.blockReads).toBe(0)
      rerender(<TranscriptList items={items} live={false} findRequest={1} onAnswer={onAnswer} />)
      expect(searchWork.rowReads).toBe(0)
      fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'needle' } })
      expect(screen.getByText('1/3')).toBeTruthy()
      expect(searchWork.rowReads).toBe(128 * scale)
      expect(searchWork.blockReads).toBe(128 * scale)
      reset()
      for (let index = 0; index < 6; index++) fireEvent.click(screen.getByLabelText('Next match'))
      fireEvent.click(screen.getByLabelText('Previous match'))
      expect(screen.getByText('3/3')).toBeTruthy()
      expect(searchWork.matches).not.toHaveBeenCalled()
      expect(searchWork.positions).toHaveBeenCalledTimes(7)
      expect(searchWork.rowReads).toBe(0)
      expect(searchWork.blockReads).toBe(0)
      samples.push({
        scale,
        rowReads: searchWork.rowReads,
        blockReads: searchWork.blockReads,
        matchQueries: searchWork.matches.mock.calls.length,
        cursorQueries: searchWork.positions.mock.calls.length,
      })
      fireEvent.click(screen.getByLabelText('Close transcript search'))
      reset()
      rerender(
        <TranscriptList
          items={[...items, { id: 'new', role: 'assistant', text: 'new needle' }]}
          live={false}
          findRequest={1}
          onAnswer={onAnswer}
        />,
      )
      expect(searchWork.rowReads).toBe(0)
      expect(searchWork.blockReads).toBe(0)
      rerender(
        <TranscriptList
          items={[...items, { id: 'new', role: 'assistant', text: 'new needle' }]}
          live={false}
          findRequest={2}
          onAnswer={onAnswer}
        />,
      )
      fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'needle' } })
      expect(screen.getByText('1/4')).toBeTruthy()
      unmount()
      reset()
    }
    expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
    console.log('[actual phone Find cursor work1x4x]', JSON.stringify(samples))
  })

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

  it('shapes settled history once while live text changes', () => {
    const settled = Array.from({ length: 64 }, (_, index) => ({
      id: `settled:${index}`,
      role: 'assistant' as const,
      text: `Settled answer ${index}`,
    }))
    const onAnswer = async () => {}
    const { rerender } = render(
      <TranscriptList
        items={settled}
        liveItem={{ id: 'super:live', role: 'assistant', text: 'Live one' }}
        live
        streaming
        onAnswer={onAnswer}
      />,
    )
    const initialViewportData = viewportData.at(-1)

    rerender(
      <TranscriptList
        items={settled}
        liveItem={{ id: 'super:live', role: 'assistant', text: 'Live two' }}
        live
        streaming
        onAnswer={onAnswer}
      />,
    )

    expect(transcriptBuilds).toHaveBeenCalledTimes(1)
    expect(transcriptBuilds).toHaveBeenCalledWith(settled)
    expect(initialViewportData).toBeDefined()
    expect(viewportData.at(-1)).toBe(initialViewportData)
    expect(markdownRenders.get('Settled answer 0')).toBe(1)
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

it('renders the Bash input as coloured inline text when a work run opens', () => {
  const command = 'echo "$HOME" && printf "%s" 42'
  const { container } = render(
    <TranscriptList
      live={false}
      onAnswer={async () => {}}
      items={[
        {
          id: 'bash-row',
          role: 'tool',
          text: '',
          toolName: 'Bash',
          toolTitle: 'Check home',
          toolInput: command,
        },
      ]}
    />,
  )
  fireEvent.click(screen.getByLabelText(/^Expand work run:/))
  const description = Array.from(container.querySelectorAll('div')).find(
    (node) => node.textContent === command && node.children.length > 2,
  )
  expect(description).toBeDefined()
  expect(getComputedStyle(description as HTMLElement).whiteSpace).toBe('nowrap')
})

/**
 * WHAT A SENT BUBBLE SAYS (POD-4764). A message the server handed on toward the
 * agent used to read "sending…" until its text matched a transcript entry —
 * forever, when the harness rewrote it. The caption now says where the synced
 * record says it is, and a message the server says did not arrive offers
 * "Send again" (a new message), never "Try again".
 */
describe('TranscriptList pending delivery captions', () => {
  const turn = (over: Record<string, unknown>) =>
    ({ id: 'msg_1', text: 'ship it', ...over }) as never

  it('says "sent" for a message on its way, not "sending…"', () => {
    render(
      <TranscriptList
        items={[]}
        live
        onAnswer={async () => {}}
        pendingTurns={[turn({ delivery: 'sent' })]}
      />,
    )
    expect(screen.getByText('sent')).toBeTruthy()
    expect(screen.queryByText('sending…')).toBeNull()
  })

  it('offers "Send again" and Dismiss on a message the server says did not arrive', () => {
    const onSendAgainPending = vi.fn()
    const onRetryPending = vi.fn()
    render(
      <TranscriptList
        items={[]}
        live
        onAnswer={async () => {}}
        onRetryPending={onRetryPending}
        onSendAgainPending={onSendAgainPending}
        onDiscardPending={() => {}}
        pendingTurns={[turn({ failed: 'not delivered · session torn down', notice: 'failed' })]}
      />,
    )
    expect(screen.getByText('not delivered')).toBeTruthy()
    expect(screen.queryByText('Try again')).toBeNull()
    fireEvent.click(screen.getByLabelText('Send again'))
    expect(onSendAgainPending).toHaveBeenCalledTimes(1)
    expect(onRetryPending).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Dismiss')).toBeTruthy()
  })

  it('says an unknown message may already have arrived before offering it again', () => {
    render(
      <TranscriptList
        items={[]}
        live
        onAnswer={async () => {}}
        onSendAgainPending={() => {}}
        pendingTurns={[turn({ delivery: 'unknown', notice: 'unknown' })]}
      />,
    )
    expect(screen.getByText('not confirmed — it may or may not have arrived')).toBeTruthy()
    expect(screen.getByLabelText('Send again — it may already have arrived')).toBeTruthy()
  })
})
