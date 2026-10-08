import type { SessionView } from '@podium/client-core/session-values'
import { matchesQuestionInteraction, type SuperThreadRef } from '@podium/client-core/values'
import { isMachineOfflineForLiveTerminal, type SessionId } from '@podium/model/browser'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePoolMachine } from '@/app/header-data'
import { useRuntimeActions } from '@/app/keyed-runtime'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import { ChatViewModel } from './chat-view-model'
import { RENDER_WINDOW } from './conversation-presentation.next'
import { type UseAttachmentsResult, useAttachments } from './use-attachments'
import type { WebConversation } from './use-conversation.next'
import { useTranscriptReveal } from './use-transcript-reveal'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

export interface UseChatLayoutOptions {
  conversation: WebConversation
  sessionId: SessionId
  active: boolean
  superThread: SuperThreadRef | undefined
  compact: boolean
  initialTurnRunning: boolean
  initialPendingText: string | undefined
  onInitialPendingSettled?: () => void
  deferInitialTranscript: boolean
}

/** DOM ports and local UI only. Observers read their display facts from view. */
export interface ChatSurface {
  conversation: WebConversation
  view: ChatViewModel
  httpOrigin: string
  attachments: UseAttachmentsResult
  isMobile: boolean
  taRef: RefObject<HTMLTextAreaElement | null>
  scrollerRef: RefObject<HTMLDivElement | null>
  scroll: UseTranscriptScrollResult
  revealedRow: number | undefined
  lightbox: string | null
  setLightbox: (url: string | null) => void
  setDraft: (text: string) => void
  submitDraft: (draft: string) => void
  sendOfferPrompt: (prompt: string, at: string) => Promise<void>
  dismissOffer: (at: string) => Promise<void>
  retractQueuedMessage: (id: string) => Promise<void>
  retryPending: (id: string) => Promise<void>
  discardPending: (id: string) => Promise<void>
  sendAgain: (id: string) => Promise<void>
  answerAsk: (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => Promise<void>
  interrupt: (draft: string) => void
  openFile: (sessionId: SessionId, path: string) => void
  tldr: () => void
}

const LAYOUT_ACTIONS = ['trpc', 'openFile', 'httpOrigin', 'tldrSession', 'clearAttachedSession', 'clearTranscriptReveal'] as const

export function useChatLayout(opts: UseChatLayoutOptions): ChatSurface {
  const { conversation, sessionId, active, superThread, compact } = opts
  const { trpc, openFile, httpOrigin, tldrSession, clearAttachedSession, clearTranscriptReveal } = useRuntimeActions(LAYOUT_ACTIONS)
  const view = useMemo(() => new ChatViewModel(conversation, compact, superThread, clearAttachedSession),
    [conversation, compact, superThread, clearAttachedSession])
  useEffect(() => { view.open(); return () => view.close() }, [view])
  const presentation = view.presentation
  const sticky = useStickyPromptsPreference()
  useEffect(() => view.setOptions(active, sticky.enabled), [view, active, sticky.enabled])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const log = conversation.transcript
  const loadOlder = useCallback(() => { void presentation.loadOlder().catch(() => {}) }, [presentation])
  const onFollowChange = useCallback((follow: boolean) => presentation.setFollowTail(follow), [presentation])
  // Only geometry is watched here. Labels, offers, errors and attachment facts
  // are read by the observers that display them.
  const scroll = useTranscriptScroll({
    sessionId, scrollerRef, active,
    blockCount: presentation.blockCount,
    renderStart: presentation.renderStart,
    stickyEnabled: view.stickyEnabled,
    moreAbove: view.moreAbove,
    loadingOlder: log.loadingOlder,
    loadOlder,
    rowsToRender: view.rowsToRender,
    onFollowChange,
    lookupAnchorRow: presentation.anchorRow,
  })
  const revealedRow = useTranscriptReveal({
    active, sessionId, request: view.transcriptReveal,
    lookupRow: presentation.revealRow, rowVersion: presentation.rowVersion,
    rowCount: presentation.rowCount, blockCount: presentation.blockCount, headKey: presentation.headKey,
    initialLoaded: log.initialLoaded, computeReady: presentation.computeReady,
    loadingOlder: log.loadingOlder, moreAbove: view.moreAbove, renderStart: presentation.renderStart,
    setRenderCount: presentation.setRenderCount, loadOlder: scroll.loadOlder,
    scrollToBlock: scroll.scrollToBlock, clear: clearTranscriptReveal,
  })
  // Unknown presence does not count as a reconnect. Losing the selected
  // machine or hiding the pane also does not fabricate an online transition.
  const machineId = active ? view.session?.machineId : undefined
  const presenceMachine = usePoolMachine(machineId)
  const presenceOnline = presenceMachine ? !isMachineOfflineForLiveTerminal(presenceMachine) : undefined
  const previousPresenceOnline = useRef(presenceOnline)
  useEffect(() => {
    const previous = previousPresenceOnline.current
    previousPresenceOnline.current = presenceOnline
    if (previous === false && presenceOnline === true && log.initialLoaded)
      void log.refresh({ disclose: true }).catch(() => {})
  }, [presenceOnline, log])

  const attachments = useAttachments({ sessionId, trpc })
  const sends = conversation.sends
  const setDraft = useCallback((text: string) => { conversation.draft = text }, [conversation])
  const submitDraft = useCallback((draft: string) => {
    const text = draft.trim()
    const { paths, legacyPaths, refs, tags } = attachments.ready()
    if ((!text && paths.length === 0) || attachments.uploading) return
    conversation.rememberPrompt(text)
    view.captureContext()
    attachments.clearReady()
    scroll.pinToBottom()
    void sends.submit({
      text: legacyPaths.length > 0 ? [legacyPaths.join('\n'), text].filter(Boolean).join('\n') : text,
      ...(tags.length ? { tags } : {}), ...(paths.length ? { toolPaths: paths } : {}),
      ...(refs.length ? { attachments: refs } : {}),
      ...(view.superThread ? { backend: view.backend } : {}),
    })
  }, [attachments, conversation, view, scroll.pinToBottom, sends])
  const sendOfferPrompt = useCallback(async (prompt: string, at: string) => {
    scroll.pinToBottom(); await sends.sendOffer(prompt, at)
  }, [scroll.pinToBottom, sends])
  const interrupt = useCallback((draft: string) => { taRef.current?.focus(); void sends.interrupt(draft) }, [sends])
  const sendActions = useMemo(() => ({
    dismissOffer: sends.dismissOffer.bind(sends), retractQueuedMessage: sends.retract.bind(sends),
    retryPending: sends.retry.bind(sends), discardPending: sends.discard.bind(sends), sendAgain: sends.sendAgain.bind(sends),
  }), [sends])
  const answerAsk = useCallback(async (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => {
    const question = view.question
    if (question && (answer.interactionId !== question.id || !answer.question || !matchesQuestionInteraction(question, answer.question)))
      throw new Error('The question changed; wait for the current menu.')
    const sent = await trpc.sessions.answerAskUserQuestion.mutate('skip' in answer
      ? { sessionId, interactionId: answer.interactionId, skip: true }
      : { sessionId, interactionId: answer.interactionId, choices: answer.choices }) as { ok?: boolean; reason?: string } | undefined
    if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
  }, [view, trpc, sessionId])
  const activeRow = presentation.search.activeRow
  useEffect(() => {
    if (activeRow === undefined) return
    if (activeRow < presentation.renderStart) {
      presentation.setRenderCount(presentation.rowCount - activeRow + RENDER_WINDOW)
      requestAnimationFrame(() => scroll.scrollToBlock(activeRow))
    } else scroll.scrollToBlock(activeRow)
  }, [activeRow, presentation, scroll.scrollToBlock])
  const isMobile = useIsMobile()
  const tldr = useCallback(() => void tldrSession(sessionId, presentation.lastAnswer.text), [tldrSession, sessionId, presentation])
  return { conversation, view, httpOrigin, attachments, isMobile, taRef, scrollerRef, scroll, revealedRow,
    lightbox, setLightbox, setDraft, submitDraft, sendOfferPrompt, ...sendActions, answerAsk, interrupt, openFile, tldr }
}

/** Presence follows only the addressed machine while the panel is visible. */
export function useChatMachinePresence(session: SessionView | undefined, active: boolean): string | null {
  const machine = usePoolMachine(active ? session?.machineId : undefined)
  return machine && isMachineOfflineForLiveTerminal(machine)
    ? session?.machineName ?? machine.name ?? session?.machineId ?? null : null
}
