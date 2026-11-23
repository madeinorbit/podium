/**
 * A START REFUSED FOR ITS CREDENTIAL (credential management §9; the
 * coordinator's note on Task 3).
 *
 * The session never started, so the exited bar's "no longer running … read-only"
 * is wrong for it. This bar says why, in the refusal's own sentence (chosen by
 * the refusal CODE on the launch record, never by matching text), and offers
 * the way out: renew the credential, or start again on another one.
 */

import { useCommands, useUi } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import {
  type CredentialChoice,
  sessionCredentialChoices,
} from '@podium/client-graph/session-credential-facts'
import {
  ACCESS_REFUSAL_MESSAGES,
  type AccessRefusal,
  type AgentKind,
  type CredentialId,
  type IssueId,
  type MachineId,
  type SessionId,
} from '@podium/model'
import { KeyRound } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CredentialMenuItems } from './CredentialMenuItems'
import { useOpenCredentials } from './SessionCredentialNotice'
import { useHarnessAccepts, useSessionCredentials } from './use-session-credentials'

export { usePaneLaunchRefusal } from './use-session-credentials'

/** Refusals renewing the credential can cure. */
const RENEWABLE: ReadonlySet<AccessRefusal> = new Set(['needs-attention'])

export function RefusedLaunchBannerView({
  refusal,
  choices,
  onRenew,
  onPick,
  onDismiss,
}: {
  refusal: AccessRefusal
  choices: readonly CredentialChoice[]
  onRenew: () => void
  onPick: (credentialId: CredentialId | null) => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="pane-state-bar" data-tone="fault" role="status">
      <span className="pane-state-bar-mark" aria-hidden="true">
        <KeyRound size={13} strokeWidth={1.7} />
      </span>
      <span className="pane-state-bar-copy">
        This session did not start. {ACCESS_REFUSAL_MESSAGES[refusal]}
      </span>
      {RENEWABLE.has(refusal) ? (
        <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={onRenew}>
          Renew
        </Button>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button type="button" size="xs" variant="outline" className="shrink-0">
              Pick another credential
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <CredentialMenuItems choices={choices} selected={undefined} onSelect={onPick} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

/** What a start's launch record published about where it starts. */
interface LaunchFacts {
  readonly agentKind?: AgentKind
  readonly cwd?: string
  readonly machineId?: MachineId
  readonly issueId?: IssueId
  readonly draftIssue?: { readonly repoPath: string; readonly issueId: IssueId }
  readonly model?: string
  readonly effort?: string
}

export const RefusedLaunchBanner = observer(function RefusedLaunchBanner({
  sessionId,
  refusal,
  firstPrompt,
}: {
  sessionId: SessionId
  refusal: AccessRefusal
  /** The prompt the start carried, which the pane still holds. */
  firstPrompt: string | undefined
}): JSX.Element {
  const readLaunch = useCallback(
    (pool: MobxPool) => pool.sessionObject(sessionId).launch?.input as LaunchFacts | undefined,
    [sessionId],
  )
  const launch = useWorklistPoolProjection(readLaunch, undefined)
  const credentials = useSessionCredentials()
  const acceptsOf = useHarnessAccepts(launch?.machineId)
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const openCredentials = useOpenCredentials()
  const choices =
    credentials.views && launch?.agentKind && launch.machineId
      ? sessionCredentialChoices({
          views: credentials.views,
          accepts: acceptsOf(launch.agentKind),
          machineId: launch.machineId,
          custodianOf: credentials.custodianOf,
        })
      : []
  const dismiss = () => void commands.sessions.killSession(sessionId)
  const startAgain = (credentialId: CredentialId | null) => {
    if (!launch?.agentKind || !launch.cwd) return
    const machine = launch.machineId ? { machineId: launch.machineId } : {}
    // The same start, on the credential picked: a refused start created nothing,
    // so it goes again under new ids and the refused one is let go.
    const started = launch.draftIssue
      ? commands.sessions.spawnDraftAgent({
          target: { path: launch.cwd, repoPath: launch.draftIssue.repoPath, ...machine },
          agentKind: launch.agentKind,
          ...(firstPrompt ? { firstPrompt } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          credentialId,
        })
      : commands.sessions.launch({
          target: { path: launch.cwd, repoPath: launch.cwd, ...machine },
          agentKind: launch.agentKind,
          ...(launch.issueId ? { issueId: launch.issueId } : {}),
          credentialId,
        })
    dismiss()
    ui.navigateToSession(started.sessionId)
  }
  return (
    <RefusedLaunchBannerView
      refusal={refusal}
      choices={choices}
      onRenew={openCredentials}
      onPick={startAgain}
      onDismiss={dismiss}
    />
  )
})
