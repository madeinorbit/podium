import { type JSX, lazy, Suspense } from 'react'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { cn } from '@/lib/utils'
import type { DeckItem } from './panel-deck'

const FilePanel = lazy(() =>
  import('@/features/files/FilePanel').then((m) => ({ default: m.FilePanel })),
)

/**
 * Renders the panel deck [POD-782] [spec:SP-0b2e] as ONE flat keyed list so a
 * session that moves between the current-tab group and the foreign-warm group
 * keeps its component identity across an issue switch (no remount → the terminal
 * and the POD-725 transcript window survive; re-selecting it is a warm reveal
 * that fires `chat:cache-hit`, not a cold `panel:mount`).
 *
 * Only the active pane(s) are visible; every other mounted panel is
 * `display:none`. A foreign warm panel is always hidden and passed `active=false`
 * — it never claims focus, and it never enters the engine's viewState (which is
 * derived from paneA/paneB, not from what is mounted), so it makes no PTY-relay
 * claim.
 */
export function PanelDeck({
  items,
  split,
  onCloseFile,
}: {
  items: DeckItem[]
  split: boolean
  onCloseFile: (id: string) => void
}): JSX.Element {
  return (
    <>
      {items.map((item) => {
        const visible = item.inA || item.inB
        // Evicted (cold) session tabs render nothing — clicking the tab makes it
        // active → warm → it remounts. The `!visible` guard is load-bearing: the
        // warm set updates in an effect (one render behind), so a just-activated
        // pane may not be in the warm set yet — always mount the visible pane
        // regardless, or it blanks for a frame. File tabs are cheap and always
        // render.
        if (item.kind === 'session' && !visible && !item.warm) return null
        return (
          <div
            key={item.id}
            className={cn(
              'min-w-0 flex-1',
              visible ? 'flex' : 'hidden',
              split && item.inB && !item.inA && 'border-l border-border',
            )}
            data-session={item.id}
            style={visible ? { order: item.inA ? 0 : 1 } : undefined}
          >
            {item.kind === 'session' ? (
              <AgentPanel sessionId={item.id} active={visible} />
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
