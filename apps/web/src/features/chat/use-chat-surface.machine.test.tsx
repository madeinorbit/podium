// @vitest-environment happy-dom
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { MachineWire } from '@podium/model/browser'
import { asMachineId, asSessionId } from '@podium/model/browser'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../../packages/worklist-proto/harness/src/work-meter'
import { useChatSurface } from './use-chat-surface'

const f = vi.hoisted(() => ({ pool: null as MobxPool | null, session: undefined as SessionView | undefined }))
const transports = vi.hoisted(() => ({ trpc: {}, hub: {}, httpOrigin: 'http://offline.invalid' }))
vi.mock('@/app/store', () => ({ useRuntimeSelector: (read: (state: typeof transports) => unknown) => read(transports) }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => ({ access: transports }) }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(f.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
// Other chat planes are inert. The changed hook uses the real pool, row storage,
// projection and live-machine predicate. The old fleet hook remains executable
// through that same pool so a regression still incurs its real full row demand.
vi.mock('./use-chat-context', () => ({
  useChatSession: (id: string | undefined) => id === f.session?.sessionId ? f.session : undefined,
  useChatSessionExitKind: () => undefined,
  useChatMachines: () => {
    const read = useMemo(() => (pool: MobxPool) => pool.headerViews.machines(), [])
    const view = useMemo(() => createPoolProjection(f.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
  useChatIssueSeq: () => () => null,
  useChatContextWindow: () => ({ attachedSessionId: null, transcriptReveal: null }),
  useChatThread: () => undefined,
  useChatInteractions: () => ({}),
}))
vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/sticky-prompts', () => ({ useStickyPromptsPreference: () => ({ enabled: false }) }))
vi.mock('./useTranscriptWindow', () => {
  const items: never[] = []
  const snapshot = { items, blocks: items, rows: items, visibleRows: items, renderStart: 0,
    moreAbove: false, loadingOlder: false, initialLoaded: true, computeReady: true,
    search: { total: 0 }, markdownHtml: new Map(), loadOlder() {}, ensureSearchDepth() {}, setRenderCount() {} }
  return { RENDER_WINDOW: 120, useTranscriptWindow: () => snapshot }
})
vi.mock('./use-transcript-scroll', () => ({ useTranscriptScroll: () => ({ loadOlder() {}, scrollToBlock() {}, pinToBottom() {} }) }))
vi.mock('./use-transcript-reveal', () => ({ useTranscriptReveal: () => undefined }))
vi.mock('./use-turn-preview', () => ({ useTurnPreview: () => null }))
vi.mock('./use-headless-turn', () => ({ useHeadlessTurn: () => ({ turnRunning: false }) }))
vi.mock('./use-attachments', () => ({ useAttachments: () => ({}) }))
vi.mock('./use-chat-send', () => ({ useChatSend: () => ({ pending: [], justSent: false, ready: true, offer: null }) }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); f.pool = null; f.session = undefined })

it('bounds actual chat presence, updates and hidden demand at 1x/4x with an armed fleet control', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    f.pool = pool
    f.session = { sessionId: asSessionId('chat'), machineId: asMachineId('m0'),
      status: 'live', agentKind: 'codex', cwd: '/repo' } as SessionView
    const machines = Array.from({ length: 128 * scale }, (_, index) => ({
      id: asMachineId(`m${index}`), name: `Host ${index}`, online: true,
    }) as MachineWire)
    pool.header.apply(machines.map(value => ({ kind: 'machine', id: value.id, value })))
    const measure = (action: () => void) => measureWork(async () => { act(action); await act(async () => {}) }, { pool })
    let view: ReturnType<typeof renderHook<ReturnType<typeof useChatSurface>, { active: boolean }>> | undefined
    try {
      const closedBefore = await measure(() => {
        view = renderHook(({ active }: { active: boolean }) => useChatSurface({
          sessionId: asSessionId('chat'), active, superThread: undefined, compact: false,
          initialTurnRunning: false, initialPendingText: undefined, deferInitialTranscript: true,
        }), { initialProps: { active: false } })
      })
      expect(closedBefore.work.rows).toBe(0)
      const first = await measure(() => view!.rerender({ active: true }))
      expect(first.work.rows).toBe(1)
      expect(view!.result.current.presenceOfflineMachineName).toBeNull()
      const unrelated = await measure(() => pool.header.apply([{ kind: 'machine', id: 'm1',
        value: { ...machines[1]!, online: false } }]))
      expect(unrelated.work.rows).toBe(0)
      const changed = await measure(() => pool.header.apply([{ kind: 'machine', id: 'm0',
        value: { ...machines[0]!, online: false } }]))
      expect(changed.work.rows).toBe(1)
      expect(view!.result.current.presenceOfflineMachineName).toBe('Host 0')
      const interaction = await measure(() => view!.result.current.setBackendEffort('high'))
      expect(interaction.work.rows).toBe(0)
      const hidden = await measure(() => view!.rerender({ active: false }))
      expect(hidden.work.rows).toBe(0)
      const closed = await measure(() => pool.header.apply([{ kind: 'machine', id: 'm0',
        value: { ...machines[0]!, online: false, name: 'While hidden' } }]))
      expect(closed.work.rows).toBe(0)
      const reopen = await measure(() => view!.rerender({ active: true }))
      expect(reopen.work.rows).toBe(1)
      expect(view!.result.current.presenceOfflineMachineName).toBe('While hidden')
      const missing = await measure(() => {
        f.session = { ...f.session!, machineId: asMachineId('missing') }
        view!.rerender({ active: true })
      })
      expect(missing.work.rows).toBe(1)
      expect(view!.result.current.presenceOfflineMachineName).toBeNull()
      view!.unmount()
      const detached = await measure(() => pool.header.apply([{ kind: 'machine', id: 'missing',
        value: { ...machines[0]!, id: asMachineId('missing'), online: false } }]))
      expect(detached.work.rows).toBe(0)
      const control = await measureWork(async () => {
        const legacy = createPoolProjection(pool, current => current.headerViews.machines())
        const stop = legacy.subscribe(() => {})
        try { expect(legacy.getSnapshot().find(machine => machine.id === asMachineId('m0'))).toBeDefined() }
        finally { stop(); legacy.dispose() }
      }, { pool })
      expect(control.work.rows).toBe(128 * scale + 1)
      samples.push({ scale, actions: { closedBefore, first, unrelated, changed, interaction, hidden, closed, reopen, missing, detached }, control })
    } finally { view?.unmount(); pool.dispose() }
  }
  for (const name of ['closedBefore', 'first', 'unrelated', 'changed', 'interaction', 'hidden', 'closed', 'reopen', 'missing', 'detached'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[name].work[counter], `${name}:${counter}`).toBe(samples[0]!.actions[name].work[counter])
  expect(samples[1]!.control.work.rows).toBeGreaterThan(samples[0]!.control.work.rows ?? 0)
  console.info('[chat presence work1x4x]', JSON.stringify(samples))
})
