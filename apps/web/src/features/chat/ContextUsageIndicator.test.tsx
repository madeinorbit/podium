import type { ContextDetailApi } from '@podium/client-graph/context-detail'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { ContextComposerFixture } from '../../../harness/context-composer-fixture'
import {
  compositionDetail,
  contextStates,
  createContextFixture,
  detailFor,
  measured,
  quantity,
  sample,
} from '../../../harness/context-usage-fixture'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { MailReply } from './mail-reply'
import { SessionComposerControls } from './SessionComposerControls'

const ports = vi.hoisted(() => ({ query: vi.fn(), configure: vi.fn() }))
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useRequestClient: () => ({ sessions: { contextRead: { query: ports.query } } }),
  useCommands: () => ({ sessions: { configure: ports.configure } }),
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))
vi.mock('./use-chat-context', () => ({ useChatMentions: () => [] }))

let fixture: ReturnType<typeof createContextFixture>
beforeEach(() => {
  fixture = createContextFixture()
  ports.query
    .mockReset()
    .mockImplementation(
      async (input: Parameters<ContextDetailApi['sessions']['contextRead']['query']>[0]) => ({
        intent: 'breakdown',
        result: {
          ...detailFor(fixture.session.context ?? measured),
          sample: input.read.intent === 'breakdown' ? input.read.sample : sample,
        },
      }),
    )
  modelCatalogFixture.current = {
    codex: [{ value: 'demo-pro', label: 'Demo Pro', efforts: ['low', 'high'] }],
  }
})
afterEach(() => {
  cleanup()
  fixture.pool.dispose()
  modelCatalogFixture.current = {}
  vi.restoreAllMocks()
})

async function open() {
  fireEvent.blur(screen.getByTestId('context-usage'))
  fireEvent.focus(screen.getByTestId('context-usage'))
  return await screen.findByTestId('context-usage-panel')
}
const rowText = (panel: HTMLElement, label: string) =>
  within(panel).getByText(label, { selector: 'dt' }).parentElement?.textContent
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close context usage' }))
function requestSignal(index: number): AbortSignal {
  const signal = ports.query.mock.calls[index]?.[1]?.signal
  if (!(signal instanceof AbortSignal)) throw new Error('Missing context request signal')
  return signal
}

describe('normalized context measurements', () => {
  it.each([
    [
      'reported',
      '84,000 (reported)',
      '200,000 (reported)',
      '116,000 (reported)',
      '42% (reported)',
      true,
    ],
    [
      'estimated',
      '42,750 (estimated)',
      '200,000 (reported)',
      '157,250 (estimated)',
      '21.375% (estimated)',
      true,
    ],
    ['zero', '0 (reported)', '200,000 (reported)', '200,000 (reported)', '0% (reported)', true],
    ['over', '250,000 (reported)', '200,000 (reported)', '0 (reported)', '125% (reported)', true],
    ['percentOnly', 'Unknown', 'Unknown', 'Unknown', '13.25% (reported)', false],
    ['countOnly', '13,000 (estimated)', 'Unknown', 'Unknown', 'Unknown', false],
    ['countCapacity', '647 (estimated)', '200,000 (reported)', 'Unknown', 'Unknown', false],
    ['remainingOnly', 'Unknown', 'Unknown', '500 (reported)', 'Unknown', false],
    ['pending', 'Unknown', '200,000 (reported)', 'Unknown', 'Unknown', false],
    ['unavailable', 'Unknown', '200,000 (reported)', 'Unknown', 'Unknown', false],
    [
      'stale',
      '84,000 (reported)',
      '200,000 (reported)',
      '116,000 (reported)',
      '42% (reported)',
      true,
    ],
    ['unsupported', 'Unknown', 'Unknown', 'Unknown', 'Unknown', false],
  ] as const)('%s preserves quantities and precision without reconstruction', async (state, used, capacity, remaining, percent, determinate) => {
    fixture.publish(contextStates[state])
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    expect(rowText(panel, 'Used tokens')).toContain(used)
    expect(rowText(panel, 'Available context')).toContain(capacity)
    expect(rowText(panel, 'Remaining tokens')).toContain(remaining)
    expect(rowText(panel, 'Usage')).toContain(percent)
    expect(screen.getByTestId('context-usage').getAttribute('data-determinate')).toBe(
      String(determinate),
    )
    if (state === 'over') {
      expect(within(panel).getByText('Over capacity')).toBeTruthy()
      expect(
        screen
          .getByTestId('context-usage')
          .querySelector('[pathLength]')
          ?.getAttribute('stroke-dasharray'),
      ).toBe('100 100')
    }
  })

  it('keeps legacy percent and unknown telemetry honest', async () => {
    fixture.publish(undefined, 13)
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    expect(rowText(panel, 'Usage')).toContain('13% (reported)')
    expect(panel.textContent).toContain('Percentage-only report')
    expect(ports.query).not.toHaveBeenCalled()
    act(() => fixture.publish(undefined))
    expect(panel.textContent).toContain('Context not reported')
    expect(rowText(panel, 'Usage')).toContain('Unknown')
  })

  it('keeps the observed model, effective basis, maximum and compaction reserve distinct', async () => {
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    expect(panel.textContent).toContain('Configured context window')
    expect(rowText(panel, 'Available context')).toContain('200,000')
    expect(rowText(panel, 'Model maximum')).toContain('1,000,000')
    expect(rowText(panel, 'Threshold tokens')).toContain('160,000')
    expect(rowText(panel, 'Compaction reserve')).toContain('20,000')
    expect(panel.textContent).toContain('Measured model: synthetic-provider / observed-model')
    expect(panel.textContent).not.toContain('demo-pro')
  })

  it('renders disjoint composition, partial children and unknown tokens separately from request subsets', async () => {
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() => expect(panel.textContent).toContain('Context composition'))
    expect(panel.textContent).toContain('Partial attribution')
    expect(panel.textContent).toContain('Within this category · partial attribution')
    expect(
      within(panel).getByText('Additional attribution · unattributed').parentElement?.textContent,
    ).toContain('Unknown')
    expect(panel.textContent).toContain('Reserve · outside used total')
    expect(panel.textContent).toContain('Deferred content · outside used total')
    expect(rowText(panel, 'Input (inclusive)')).toContain('80,000')
    expect(rowText(panel, 'Cache read (input subset)')).toContain('60,000')
    expect(rowText(panel, 'Output (inclusive)')).toContain('4,000')
    expect(rowText(panel, 'Reasoning (output subset)')).toContain('1,000')
    expect(rowText(panel, 'Used tokens')).toContain('84,000')
  })

  it('labels accounting-only detail and missing parent counts', async () => {
    ports.query.mockResolvedValue({
      intent: 'breakdown',
      result: {
        ...detailFor(measured, true),
        lastRequest: { cacheRead: quantity(500), reasoning: quantity(0) },
      },
    })
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() => expect(panel.textContent).toContain('Last-request accounting'))
    expect(panel.textContent).toContain('Semantic composition unavailable')
    expect(rowText(panel, 'Input (inclusive)')).toContain('Unknown')
    expect(rowText(panel, 'Output (inclusive)')).toContain('Unknown')
    expect(rowText(panel, 'Reasoning (output subset)')).toContain('0 (reported)')
  })

  it.each([
    0, 84_000,
  ])('shows a richer composition total of %s without filling the pushed summary', async (value) => {
    fixture.publish(contextStates.percentOnly)
    ports.query.mockResolvedValue({
      intent: 'breakdown',
      result: {
        version: 1,
        status: 'available',
        sample,
        composition: {
          coverage: 'partial',
          usedTokens: quantity(value),
          rows: [],
          truncated: false,
        },
      },
    })
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() =>
      expect(rowText(panel, 'Composition occupied total')).toContain(
        value === 0 ? '0 (reported)' : '84,000 (reported)',
      ),
    )
    expect(rowText(panel, 'Used tokens')).toContain('Unknown')
    expect(rowText(panel, 'Available context')).toContain('Unknown')
    expect(rowText(panel, 'Usage')).toContain('13.25% (reported)')
    expect(fixture.session.contextOccupancy?.usedTokens).toBeUndefined()
    expect(fixture.session.contextCapacity).toBeUndefined()
  })

  it.each([
    'complete',
    'unknown',
  ] as const)('labels %s and truncated attribution without overstating coverage', async (coverage) => {
    ports.query.mockResolvedValue({
      intent: 'breakdown',
      result: {
        ...detailFor(measured),
        composition: {
          ...compositionDetail,
          coverage,
          truncated: coverage === 'unknown',
          rows:
            coverage === 'complete'
              ? [
                  {
                    id: 'all',
                    label: 'Occupied messages',
                    category: 'messages',
                    kind: 'used',
                    attribution: 'category',
                    tokens: quantity(84_000),
                  },
                ]
              : [],
        },
      },
    })
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() =>
      expect(panel.textContent).toContain(
        coverage === 'complete'
          ? 'Complete attribution'
          : 'Attribution coverage unknown · List truncated',
      ),
    )
  })
})

describe('detail ownership and generic composition', () => {
  it('dismisses before ancestor capture handlers and leaves shortcuts available after close', async () => {
    const captured = vi.fn()
    render(
      <div onKeyDownCapture={captured}>
        <ContextUsageIndicator session={fixture.session} />
      </div>,
    )
    await open()
    fireEvent.keyDown(screen.getByTestId('context-usage'), { key: 'Escape' })
    expect(captured).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('context-usage'), { key: 'Escape' })
    expect(captured).toHaveBeenCalledTimes(1)
  })

  it('closes context demand on entering reply mode and preserves reply Escape outside the panel', async () => {
    ports.query.mockImplementation(() => new Promise(() => {}))
    const reply = new MailReply(fixture.pool, { show: async () => null, reply: async () => null })
    const interrupt = vi.fn()
    render(
      <ContextComposerFixture session={fixture.session} reply={reply} onInterrupt={interrupt} />,
    )
    await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(1))
    act(() =>
      reply.start({
        id: 'synthetic-note',
        from: 'issue:POD-1',
        to: 'operator',
        body: 'Synthetic question',
        question: true,
        expectsReply: false,
      }),
    )
    expect(screen.queryByTestId('context-usage-panel')).toBeNull()
    expect(requestSignal(0).aborted).toBe(true)
    expect(reply.active).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(reply.active).toBe(false)
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('makes no reads for renders, keystrokes, hidden views or summary updates', async () => {
    const view = render(
      <PanelVisible visible={false}>
        <ContextUsageIndicator session={fixture.session} />
      </PanelVisible>,
    )
    expect(screen.queryByTestId('context-usage')).toBeNull()
    view.rerender(<ContextComposerFixture session={fixture.session} />)
    const textarea = screen.getByRole('textbox')
    for (let i = 0; i < 20; i++) fireEvent.change(textarea, { target: { value: `draft ${i}` } })
    act(() => fixture.publish(contextStates.estimated))
    expect(ports.query).not.toHaveBeenCalled()
  })

  it('loads once per opening and clears/aborts on close, hide and session replacement', async () => {
    ports.query.mockImplementation(() => new Promise(() => {}))
    const view = render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(1))
    fireEvent.focus(screen.getByTestId('context-usage'))
    view.rerender(<ContextUsageIndicator session={fixture.session} />)
    expect(ports.query).toHaveBeenCalledTimes(1)
    expect(panel.textContent).toContain('Loading breakdown')
    expect(rowText(panel, 'Used tokens')).toContain('84,000')
    let signal = requestSignal(0)
    close()
    expect(signal.aborted).toBe(true)
    await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(2))
    signal = requestSignal(1)
    view.rerender(<ContextUsageIndicator session={fixture.session} active={false} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByTestId('context-usage-panel')).toBeNull()
    view.rerender(<ContextUsageIndicator session={fixture.session} />)
    await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(3))
    signal = requestSignal(2)
    view.rerender(<ContextUsageIndicator session={fixture.other} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByTestId('context-usage-panel')).toBeNull()
  })

  it('discards old-sample detail without an automatic replacement read', async () => {
    let finish!: (value: unknown) => void
    ports.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(1))
    act(() =>
      fixture.publish({
        ...measured,
        sample: { ...sample, id: 'next-sample' },
        occupancy: { ...measured.occupancy, usedTokens: quantity(90_000) },
      }),
    )
    await act(async () => finish({ intent: 'breakdown', result: detailFor(measured) }))
    expect(rowText(panel, 'Used tokens')).toContain('90,000')
    expect(panel.textContent).not.toContain('System instructions')
    expect(panel.textContent).toContain('No breakdown loaded for this measurement')
    expect(ports.query).toHaveBeenCalledTimes(1)
  })

  it('retains summary after failure and retries only deliberately', async () => {
    ports.query.mockRejectedValue(new Error('invented transport failure'))
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await screen.findByText('Context detail could not be read')
    expect(rowText(panel, 'Used tokens')).toContain('84,000')
    fireEvent.focus(screen.getByTestId('context-usage'))
    expect(ports.query).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry breakdown' }))
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(2))
  })

  it('stales offline, preserves the last summary and cancels detail demand', async () => {
    ports.query.mockImplementation(() => new Promise(() => {}))
    render(<ContextUsageIndicator session={fixture.session} />)
    const panel = await open()
    await waitFor(() => expect(ports.query).toHaveBeenCalledTimes(1))
    act(() => fixture.live.online(fixture.row.machineId, false))
    expect(panel.textContent).toContain('Stale measurement')
    expect(rowText(panel, 'Used tokens')).toContain('84,000')
    expect(requestSignal(0).aborted).toBe(true)
    expect(ports.query).toHaveBeenCalledTimes(1)
  })

  it('puts the circle directly after configurable and read-only model/effort controls', () => {
    const view = render(<SessionComposerControls session={fixture.session} />)
    expect(screen.getByTestId('session-model').nextElementSibling).toBe(
      screen.getByTestId('context-usage'),
    )
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toContain('Demo Pro')
    expect(screen.getByRole('button', { name: 'Effort' }).textContent).toContain('High')
    fixture.pool.dispose()
    fixture = createContextFixture('reported', false, true)
    view.rerender(<SessionComposerControls session={fixture.session} />)
    expect(screen.getByTestId('session-model').getAttribute('data-configurable')).toBe('false')
    expect(screen.getByTestId('session-model').nextElementSibling).toBe(
      screen.getByTestId('context-usage'),
    )
  })

  it('renders the same circle/detail for a previously unknown harness even with no model chip', async () => {
    fixture.pool.dispose()
    fixture = createContextFixture('reported', true)
    render(<SessionComposerControls session={fixture.session} />)
    expect(screen.queryByTestId('session-model')).toBeNull()
    const panel = await open()
    await waitFor(() => expect(panel.textContent).toContain('Context composition'))
    expect(rowText(panel, 'Used tokens')).toContain('84,000')
  })

  it('exposes a meaningful accessible button and dismisses Escape before composer/global shortcuts', async () => {
    const send = vi.fn(),
      interrupt = vi.fn(),
      globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)
    try {
      render(
        <ContextComposerFixture session={fixture.session} onSend={send} onInterrupt={interrupt} />,
      )
      const trigger = screen.getByRole('button', { name: /Context usage\. Current measurement/ })
      expect(trigger.getAttribute('type')).toBe('button')
      expect(trigger.getAttribute('aria-label')).toContain('84,000 (reported) tokens used')
      expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      await open()
      fireEvent.keyDown(trigger, { key: 'Enter' })
      fireEvent.keyDown(trigger, { key: ' ' })
      expect(send).not.toHaveBeenCalled()
      // Escape from the textarea must not reach either the textarea's double
      // Escape interrupt chord or the shell's global handler while open.
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      expect(screen.queryByTestId('context-usage-panel')).toBeNull()
      expect(interrupt).not.toHaveBeenCalled()
      expect(globalEscape).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', globalEscape)
    }
  })
})
