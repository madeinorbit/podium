import { DraftStore } from '@podium/client-core/conversation'
import { MobxPool } from '@podium/client-graph'
import { chatActivityState, chatSessionReference, composerState, pendingAskFromState, transcriptAttributionTable, transcriptPhase } from '@podium/client-core/values'
import { asSessionId, isAgentComputing } from '@podium/model'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { ChatViewModel } from './chat-view-model'
import { createWebConversation } from './use-conversation.next'

function fixture() {
  vi.stubGlobal('Worker', undefined)
  const id = asSessionId('shown')
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const session = (title: string, status = 'live') => ({ kind: 'session' as const, id,
    value: { sessionId: id, title, agentKind: 'claude-code', status, headless: false, cwd: '/repo',
      machineId: 'machine', issueId: 'issue', archived: false, lastActiveAt: '2026-10-01T00:00:00Z' } as never })
  const issue = (title: string) => ({ kind: 'issue' as const, id: 'elsewhere', value: {
    id: 'elsewhere', title, seq: 8, repoPath: '/repo', stage: 'planning', archived: false, deps: [], labels: [],
    description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01',
  } as never })
  pool.apply({ type: 'replace', rows: [session('Shown'), issue('Other')] })
  const held = { sends: [] }, window = { attachedSessionId: null, transcriptReveal: null }
  pool.sources.register(['chatHeld', 'chatContextReader', 'chatWindow', 'sessionExit'], {
    read: (kind: string) => kind === 'chatHeld' ? held : kind === 'chatWindow' ? window : kind === 'sessionExit' ? { kind: undefined }
      : { records: () => ({ records: [], pending: 0 }), interactions: () => ({ blocked: false, question: undefined, pending: 0 }) },
    dispose() {},
  } as never)
  const drafts = new DraftStore({ storage: { get: () => null, set: () => {} } })
  const runtime = { drafts, access: {
    hub: { subscribeTranscript: () => () => {} },
    trpc: { sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } } },
    getUserFocus: () => ({}),
  } } as any
  const conversation = createWebConversation(runtime, pool, id, {})
  const view = new ChatViewModel(conversation, false, undefined, () => {})
  view.open()
  return { pool, id, session, issue, conversation, view, dispose: () => { view.close(); conversation.dispose(); drafts.dispose(); pool.dispose(); vi.unstubAllGlobals() } }
}

/** The display questions as the old root hook answered them, on the same data. */
function oldAnswers(f: ReturnType<typeof fixture>) {
  const session = f.conversation.session, p = f.view.presentation
  const reference = chatSessionReference(f.id, session ? [session] : [], () => undefined)
  const headless = session?.headless === true
  const pendingIndex = session?.status === 'live' || session?.status === 'starting' ? p.pendingAskIndex : -1
  return {
    cwd: session?.cwd ?? '/', headless,
    phase: transcriptPhase({ reference, blockCount: p.blockCount, pendingCount: f.conversation.hasPending ? 1 : 0,
      initialLoaded: f.conversation.transcript.initialLoaded && p.computeReady }),
    composer: composerState({ session, headless, turnRunning: f.conversation.turnRunning, compact: false }),
    activity: chatActivityState({ session, headless, turnRunning: f.conversation.turnRunning, justSent: f.conversation.sends.justSent }),
    pendingAsk: pendingAskFromState(session?.agentState?.need, session?.status, session?.agentState?.phase, pendingIndex >= 0),
    turnActive: (session !== undefined && isAgentComputing(session)) || f.conversation.sends.justSent,
    attribution: transcriptAttributionTable(session),
  }
}
const newAnswers = (view: ChatViewModel) => ({ cwd: view.cwd, headless: view.headless, phase: view.phase,
  composer: view.composer, activity: view.activity, pendingAsk: view.pendingAskBlock, turnActive: view.turnActive, attribution: view.attribution })

it('matches the old display answers for each session state and rejects a wrong visible field', () => {
  const f = fixture()
  try {
    for (const status of ['starting', 'live', 'reconnecting', 'hibernated', 'exited']) {
      f.pool.apply({ type: 'update', rows: [f.session('Shown', status)] })
      expect(newAnswers(f.view)).toEqual(oldAnswers(f))
    }
    expect(() => expect({ ...newAnswers(f.view), cwd: '/wrong' }).toEqual(oldAnswers(f))).toThrow()
  } finally { f.dispose() }
})

it('leaves conversation chrome asleep on unrelated issue edits and sends visible fields to their observer', () => {
  const f = fixture(), seen = { shell: 0, composer: 0, title: 0, error: 0 }
  const stops = [
    autorun(() => { f.view.phase; f.view.rowsToRender; seen.shell++ }),
    autorun(() => { f.view.composer.placeholder; seen.composer++ }),
    autorun(() => { f.view.session?.title; seen.title++ }),
    autorun(() => { f.view.turnError; seen.error++ }),
  ]
  try {
    seen.shell = seen.composer = seen.title = seen.error = 0
    f.pool.apply({ type: 'update', rows: [f.issue('Unrelated edit')] })
    expect(seen).toEqual({ shell: 0, composer: 0, title: 0, error: 0 })
    f.pool.apply({ type: 'update', rows: [f.session('New visible title')] })
    expect(seen).toEqual({ shell: 0, composer: 0, title: 1, error: 0 })
    runInAction(() => f.conversation.setTurnError('Visible error'))
    expect(seen.error).toBe(1)
    expect(seen.shell).toBe(0)
  } finally { for (const stop of stops) stop(); f.dispose() }
})

it('keeps backend choices and captured context on each view', () => {
  const f = fixture(), two = new ChatViewModel(f.conversation, false, undefined, () => {})
  try {
    f.view.setBackendModel('chosen', 'claude-code'); f.view.setBackendEffort('high')
    expect(f.view.backend).toMatchObject({ model: 'chosen', effort: 'high' })
    expect(two.backend).toMatchObject({ model: 'auto', effort: 'auto' })
    expect('backendPick' in f.conversation).toBe(false)
    expect('ctxSeq' in f.conversation).toBe(false)
  } finally { f.dispose() }
})
