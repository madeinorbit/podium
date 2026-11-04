import type { MobxPool } from '@podium/client-graph'
import { headerModel } from '@podium/client-graph/header-companion'
import { canonicalIssueCloseReason } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { FIRST_PROMPT_ANCHOR } from '@/features/setup/FirstPromptTip'
import { taskRowAnchor } from '@/features/worklist/first-send-tip'
import { useTipAnchorElement, useTipAnchorVisible } from './anchors'
import { openPodiumRepo } from './github-star-link'
import { useTipMoment, useTipUnseen } from './tip-context'
import type { TipCard } from './types'

/** Finished tasks that make an account eligible. */
const FINISHED_TASKS_TO_ASK = 3
/** How long a closed task still counts as just finished. */
const JUST_FINISHED_MS = 10 * 60 * 1000

type StarSurface = 'finished_task' | 'new_prompt'
type Trpc = ReturnType<typeof useTrpc>

const useTrpc = () => useRuntimeSelector((s) => s.trpc)
const readEligible = (pool: MobxPool): boolean => pool.finishedTaskCount >= FINISHED_TASKS_TO_ASK
const useEligible = (): boolean => useWorklistPoolProjection(readEligible, false)

function record(trpc: Trpc, event: 'shown' | 'clicked', surface: StarSurface): void {
  // Counting must never get in the way of the card.
  void trpc.telemetry.recordGithubStar.mutate({ event, surface }).catch(() => {})
}

/**
 * THE ONE-TIME STAR CARD. Two surfaces register one moment, so the engine shows
 * it once whichever is ready first: `Star on GitHub`, `Not now`, × and Esc each
 * end it for good. The state is `tips.seen.github-star`, nothing else.
 */
function starCards(
  anchor: string,
  surface: StarSurface,
  trpc: Trpc,
  on?: { onShow(): void; onHide(): void },
): TipCard[] {
  return [
    {
      anchor,
      title: 'Star us on GitHub.',
      body: 'It helps other developers find Podium.',
      standalone: { eyebrow: 'Now that you’re shipping', declineLabel: 'Not now' },
      onShow: () => {
        record(trpc, 'shown', surface)
        on?.onShow()
      },
      onHide: on?.onHide,
      cta: {
        label: 'Star on GitHub',
        onClick: () => {
          record(trpc, 'clicked', surface)
          openPodiumRepo()
          toast('Thanks ♥')
        },
      },
    },
  ]
}

/** The open task's id, when it closed as done moments ago. */
const readJustFinishedId = (pool: MobxPool): string | null => {
  const issue = headerModel(pool).selectedIssue
  if (typeof issue === 'symbol' || !issue || issue.stage !== 'done' || !issue.closedAt) return null
  const reason = canonicalIssueCloseReason(issue.closedReason)
  if (reason && reason !== 'done') return null
  return Date.now() - Date.parse(issue.closedAt) < JUST_FINISHED_MS ? issue.id : null
}

/** True while the person is actually in this window. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const update = () => setFocused(document.hasFocus())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])
  return focused
}

/** The first surface: the task that just finished, while it is open and watched. */
export const GitHubStarOnFinishedTask = observer(function GitHubStarOnFinishedTask(): null {
  const trpc = useTrpc()
  const unseen = useTipUnseen('github-star')
  const eligible = useEligible()
  const finishedId = useWorklistPoolProjection(readJustFinishedId, null)
  const focused = useWindowFocused()
  const anchorName = unseen && eligible && focused && finishedId ? taskRowAnchor(finishedId) : null
  const rowVisible = useTipAnchorVisible(useTipAnchorElement(anchorName))
  useTipMoment('github-star', {
    active: anchorName !== null && rowVisible,
    cards: anchorName ? starCards(anchorName, 'finished_task', trpc) : [],
  })
  return null
})

/** The fallback: a task finished unwatched, so the next new-prompt screen asks. */
export function useGitHubStarOnNewPrompt({
  first,
  setShowing,
}: {
  first: boolean
  setShowing(on: boolean): void
}): void {
  const trpc = useTrpc()
  const eligible = useEligible()
  useTipMoment('github-star', {
    active: eligible && !first,
    cards: starCards(FIRST_PROMPT_ANCHOR, 'new_prompt', trpc, {
      onShow: () => setShowing(true),
      onHide: () => setShowing(false),
    }),
  })
}
