import { useRequestClient } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { headerModel } from '@podium/client-graph/header-companion'
import { LOADING } from '@podium/client-graph/loading'
import { canonicalIssueCloseReason } from '@podium/model/browser'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { usePanelVisible } from '@/app/panel-visible'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { FIRST_PROMPT_ANCHOR } from '@/features/setup/FirstPromptTip'
import { taskRowAnchor } from '@/features/worklist/first-send-tip'
import { findTipAnchor, useTipAnchorElement, useTipAnchorVisible } from './anchors'
import { openPodiumRepo } from './github-star-link'
import { useTipMoment, useTipUnseen } from './tip-context'
import type { TipCard } from './types'

const FINISHED_TASKS_TO_ASK = 3
const JUST_FINISHED_MS = 10 * 60 * 1000
type StarSurface = 'finished_task' | 'new_prompt'
type Hooks = { onShow(): void; onHide(): void }

const readEligible = (pool: MobxPool): boolean => {
  const count = pool.finishedTaskCount
  return count !== LOADING && count >= FINISHED_TASKS_TO_ASK
}
const ineligible = () => false

function record(trpc: Trpc, event: 'shown' | 'clicked', surface: StarSurface): void {
  // The existing emitter enforces usage consent. A failed count cannot block the card.
  void trpc.telemetry.recordGithubStar.mutate({ event, surface }).catch(() => {})
}

/** Both places share one account moment, spent as soon as it appears. */
export function githubStarCards(
  anchor: string,
  surface: StarSurface,
  trpc: Trpc,
  on?: Hooks,
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

const windowFocused = () => document.hasFocus() && document.visibilityState === 'visible'
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(windowFocused)
  useEffect(() => {
    const update = () => setFocused(windowFocused())
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return focused
}

function useStarMoment(
  anchor: string | null,
  surface: StarSurface,
  active: () => boolean,
  on?: Hooks,
): void {
  const trpc = useRequestClient<Trpc>()
  const unseen = useTipUnseen('github-star')
  const eligible = useWorklistPoolProjection(unseen ? readEligible : ineligible, false)
  const focused = useWindowFocused()
  const panelVisible = usePanelVisible()
  const wanted = unseen && eligible && focused && panelVisible && active()
  const visible = useTipAnchorVisible(useTipAnchorElement(wanted ? anchor : null))
  useTipMoment('github-star', {
    get active() {
      // Recheck at queue drain, after any quiet delay or window visibility change.
      return wanted && visible && windowFocused() && active() && !!anchor && !!findTipAnchor(anchor)
    },
    cards: anchor ? githubStarCards(anchor, surface, trpc, on) : [],
  })
}

const readFinished = (pool: MobxPool) => {
  const issue = headerModel(pool).selectedIssue
  if (!issue || issue === LOADING || issue.stage !== 'done' || !issue.closedAt) return null
  const reason = canonicalIssueCloseReason(issue.closedReason)
  return reason && reason !== 'done' ? null : issue
}
const readFinishedId = (pool: MobxPool): string | null => readFinished(pool)?.id ?? null
const readFinishedAt = (pool: MobxPool): string | null => readFinished(pool)?.closedAt ?? null

/** Prefer the just-finished task when its open sidebar row is being watched. */
export function GitHubStarOnFinishedTask(): null {
  const id = useWorklistPoolProjection(readFinishedId, null)
  const at = useWorklistPoolProjection(readFinishedAt, null)
  useStarMoment(
    id ? taskRowAnchor(id) : null,
    'finished_task',
    () => at !== null && Date.now() - Date.parse(at) < JUST_FINISHED_MS,
  )
  return null
}

/** A task can finish unwatched. Ask on the next visible new-task composer instead. */
export function useGitHubStarOnNewPrompt({
  first,
  setShowing,
}: {
  first: boolean
  setShowing(on: boolean): void
}): void {
  useStarMoment(FIRST_PROMPT_ANCHOR, 'new_prompt', () => !first, {
    onShow: () => setShowing(true),
    onHide: () => setShowing(false),
  })
}
