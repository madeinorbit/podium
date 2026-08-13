import { asSessionId } from '@podium/model/browser'
import {
  type ClipboardEventHandler,
  type FormEventHandler,
  type JSX,
  type KeyboardEventHandler,
  lazy,
  Suspense,
  useCallback,
} from 'react'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { cn } from '@/lib/utils'
import { type DeckItem, type PaneRect, panelBoxStyle } from './panel-deck'

const FilePanel = lazy(() =>
  import('@/features/files/FilePanel').then((m) => ({ default: m.FilePanel })),
)

/** Keys that are only ever a modifier being held — pressing one alone is not input. */
const BARE_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
])

/** Does this keydown count as "the operator put input into the session"? */
export function isPromotingKey(key: string): boolean {
  return !BARE_MODIFIER_KEYS.has(key)
}

/** Handlers that promote a preview tab, spread onto a panel's wrapper. */
export interface PromotionHandlers {
  onKeyDownCapture: KeyboardEventHandler
  onPasteCapture: ClipboardEventHandler
  onSubmitCapture: FormEventHandler
}

/**
 * The ONE place that decides what promotes a preview tab (POD-710).
 *
 * A preview tab becomes permanent when the operator puts input INTO the session:
 * any keydown that is not a bare modifier, a paste, or a composer submit inside
 * the panel's own subtree. Reading gestures deliberately do not count —
 * scrolling, clicking and taking focus leave the tab temporary, which is what
 * makes cycling through sessions in the flight deck cheap.
 *
 * Capture phase on purpose: the terminal and the composer handle (and often stop)
 * these events themselves, so a bubble-phase listener would never see them.
 */
export function usePreviewPromotion(
  previewTabId: string | null | undefined,
  onPromote: ((tabId: string) => void) | undefined,
): (tabId: string) => PromotionHandlers | undefined {
  return useCallback(
    (tabId: string) => {
      if (!onPromote || !previewTabId || tabId !== previewTabId) return undefined
      const promote = (): void => onPromote(tabId)
      return {
        onKeyDownCapture: (e) => {
          if (isPromotingKey(e.key)) promote()
        },
        onPasteCapture: promote,
        onSubmitCapture: promote,
      }
    },
    [previewTabId, onPromote],
  )
}

/**
 * Renders the panel deck [POD-782] [spec:SP-0b2e] as ONE flat keyed list so a
 * session that moves between the current-tab group and the foreign-warm group
 * keeps its component identity across an issue switch (no remount → the terminal
 * and the POD-725 transcript window survive; re-selecting it is a warm reveal
 * that fires `chat:cache-hit`, not a cold `panel:mount`).
 *
 * Only the panes on screen are visible; every other mounted panel is
 * `display:none`. A foreign warm panel is always hidden and passed `active=false`
 * — it never claims focus, and it never enters the engine's viewState (which is
 * derived from the workspace layout, not from what is mounted), so it makes no
 * PTY-relay claim.
 *
 * A visible panel is ABSOLUTELY POSITIONED into its pane's box (POD-710 wave 2).
 * That is what lets the split tree be arbitrary — two panes or six, either axis,
 * nested — while the list stays flat and no panel is ever reparented by a split,
 * a resize or a cross-pane drag.
 */
export function PanelDeck({
  items,
  panes,
  onCloseFile,
  previewTabId,
  onPromote,
  onFocusPane,
  focusedTabId,
}: {
  items: DeckItem[]
  /** Where each ON-SCREEN pane sits, in fractions of the deck box. */
  panes: PaneRect[]
  onCloseFile: (id: string) => void
  /** The workspace's one temporary tab, if any — the only panel that can promote. */
  previewTabId?: string | null
  /** Make a preview tab permanent (the operator typed into it). */
  onPromote?: (tabId: string) => void
  /** Clicking into a pane moves input focus to it. */
  onFocusPane?: (paneId: string) => void
  /** Active tab in the workspace's focused pane; desktop session shortcuts are
   *  routed only to this panel when several panes are visible. */
  focusedTabId?: string | null
}): JSX.Element {
  const promotionFor = usePreviewPromotion(previewTabId, onPromote)
  const boxes = new Map(panes.map((rect) => [rect.paneId, rect]))
  return (
    <>
      {items.map((item) => {
        const rect = item.paneId === null ? undefined : boxes.get(item.paneId)
        const visible = rect !== undefined
        // Evicted (cold) session tabs render nothing — clicking the tab makes it
        // active → resident → it remounts. The `!visible` guard is load-bearing: the
        // warm set updates in an effect (one render behind), so a just-activated
        // pane may not be in the warm set yet — always mount the visible pane
        // regardless, or it blanks for a frame. File tabs are cheap and always
        // render.
        if (item.kind === 'session' && !visible && !item.warm) return null
        const paneId = item.paneId
        return (
          <div
            key={item.id}
            className={cn('absolute min-w-0', visible ? 'flex' : 'hidden')}
            data-session={item.id}
            data-panel-resident={item.kind === 'session' ? '' : undefined}
            data-pane={visible ? paneId : undefined}
            style={rect ? panelBoxStyle(rect) : undefined}
            // Pointer-down, not click: focus must move BEFORE the terminal or the
            // composer swallows the event, and taking focus is not a promotion
            // (usePreviewPromotion owns that).
            onPointerDownCapture={
              visible && paneId && onFocusPane ? () => onFocusPane(paneId) : undefined
            }
            {...(visible ? promotionFor(item.id) : undefined)}
          >
            {item.kind === 'session' ? (
              <AgentPanel
                sessionId={asSessionId(item.id)}
                active={visible}
                focused={visible && item.id === focusedTabId}
              />
            ) : item.file ? (
              <Suspense fallback={null}>
                <FilePanel
                  scope={item.file.scope}
                  path={item.file.path}
                  onClose={() => onCloseFile(item.id)}
                />
              </Suspense>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
