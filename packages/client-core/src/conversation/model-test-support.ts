// Test adapters preserve the old behavior scenarios while the stores themselves
// expose only direct observables. Each legacy transcript push enters a real log action.
import { action, computed, observable, reaction } from 'mobx'
import type {
  ConversationSendOptions,
  ConversationContext,
  ConversationState,
  ConversationSurfaceState,
} from './contracts'
import { Sends } from './sends'
import { TranscriptLog } from './transcript-log'

export function createSendsFixture(options: ConversationSendOptions) {
  const context = observable.box<ConversationContext>({ canInterrupt: false }, { deep: false })
  const draft = observable.box(options.initialDraft ?? '')
  let active = false
  let sends: Sends | undefined
  const transcript = new TranscriptLog({
    sessionId: options.sessionId,
    source: {
      // The legacy test port explicitly pushes each snapshot. An empty authority
      // probe preserves that stream without leaking an unrelated asynchronous
      // full-history read into a later action's bounded-work measurement.
      read: async () => ({ items: [], hasMore: false }),
      subscribe: () => () => {},
    },
    cache: {
      read: () => ({ items: [...options.transcript.getSnapshot().items], savedAt: 0 }),
      write: () => {},
    },
    onChange: (change) => {
      if (active) sends?.reconcile(change)
    },
  })
  sends = new Sends({
    ...options,
    transcript,
    readContext: () => context.get(),
    drafts: {
      get: () => draft.get(),
      set: action((_id, text) => {
        draft.set(text)
        options.onDraftChange?.(text)
      }),
    },
  })
  const model = sends
  let offTranscript: (() => void) | undefined
  const surface = computed<ConversationSurfaceState>(() => ({
    sessionId: options.sessionId,
    pending: model.pending,
    bubbles: model.bubbles,
    offer: model.offer,
    dismissedOfferAt: model.dismissedOfferAt,
    justSent: model.justSent,
    canInterrupt: model.canInterrupt,
    interruptError: model.interruptError,
    interruptMessageId: model.interruptMessageId,
  }))
  const snapshot = computed<ConversationState>(() => ({ ...surface.get(), draft: model.draft }))
  // A mounted observer keeps derived identities cached. Release it with the fixture.
  const retain = reaction(
    () => surface.get(),
    () => {},
  )
  const retainSnapshot = reaction(
    () => snapshot.get(),
    () => {},
  )
  return {
    model,
    transcript,
    getSnapshot: () => snapshot.get(),
    getSurfaceSnapshot: () => surface.get(),
    subscribe: (listener: () => void) => reaction(() => snapshot.get(), listener),
    subscribeSurface: (listener: () => void) => reaction(() => surface.get(), listener),
    updateContext: action((next: ConversationContext) => context.set(next)),
    setDraft: model.setDraft.bind(model),
    replaceDraft: action((text: string) => draft.set(text)),
    start: () => {
      if (active) return
      transcript.merge([...options.transcript.getSnapshot().items], { reset: true })
      active = true
      offTranscript = options.transcript.subscribe(() =>
        transcript.merge([...options.transcript.getSnapshot().items], { reset: true }),
      )
      model.start()
    },
    stop: () => {
      active = false
      offTranscript?.()
      offTranscript = undefined
      model.stop()
    },
    dispose: () => {
      active = false
      model.dispose()
      transcript.dispose()
      offTranscript?.()
      retain()
      retainSnapshot()
    },
    submit: model.submit.bind(model),
    sendOffer: model.sendOffer.bind(model),
    retry: model.retry.bind(model),
    discard: model.discard.bind(model),
    sendAgain: model.sendAgain.bind(model),
    retract: model.retract.bind(model),
    dismissOffer: model.dismissOffer.bind(model),
    interrupt: model.interrupt.bind(model),
    markInterrupted: model.markInterrupted.bind(model),
  }
}
