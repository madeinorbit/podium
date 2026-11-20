/**
 * THE CREDENTIAL ON A SESSION, AND SWITCHING IT (credential management §9
 * "Choosing for a session", "Switching a session to another credential").
 *
 * The chip names the credential and its kind, so a person sees at a glance
 * whether a session spends a subscription or bills by the token. It opens the
 * switch: the credentials this session's harness can use on its machine, and
 * its own login. A switch asked while a turn runs never interrupts on its own:
 * the person chooses between waiting for the turn to end and interrupting it.
 */

import { useRequestClient, useUi } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type AcceptLine,
  type CustodianOf,
  KIND_WORDS,
  sessionCredentialChoices,
  sessionCredentialLine,
} from '@podium/client-graph/session-credential-facts'
import type { SessionSwitchCredentialOutput } from '@podium/commands'
import { type CredentialId, type CredentialView, isTurnOpen, type SessionId } from '@podium/model'
import { KeyRound } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type JSX, type ReactElement, useState } from 'react'
import { toast } from 'sonner'
import type { Trpc } from '@/app/trpc'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { CredentialMenuItems } from './CredentialMenuItems'
import { switchOutcome } from './switch-outcome'
import {
  useHarnessAccepts,
  usePaneLaunchRefusal,
  useSessionCredentials,
} from './use-session-credentials'

/** The session facts the chip reads. */
export type ChipSession = Pick<
  SessionView,
  | 'sessionId'
  | 'agentKind'
  | 'machineId'
  | 'status'
  | 'credentialId'
  | 'effectiveAuth'
  | 'agentState'
>

export type SwitchCredential = (
  credentialId: CredentialId | null,
  whenBusy: 'wait' | 'interrupt',
) => Promise<unknown>

interface SwitchMenuProps {
  session: ChipSession
  views: readonly CredentialView[] | undefined
  accepts: readonly AcceptLine[]
  custodianOf: CustodianOf
  onSwitch: SwitchCredential
}

/** The switch menu behind any trigger: the chip, or a notice's "Switch credential". */
export function SwitchCredentialMenu({
  trigger,
  session,
  views,
  accepts,
  custodianOf,
  onSwitch,
}: SwitchMenuProps & { trigger: ReactElement }): JSX.Element {
  const [asking, setAsking] = useState<{ value: CredentialId | null } | undefined>(undefined)
  const current = session.credentialId ?? null
  const choices =
    views && session.machineId
      ? sessionCredentialChoices({ views, accepts, machineId: session.machineId, custodianOf })
      : []
  const choose = (value: CredentialId | null) => {
    if (value === current) return
    if (session.status === 'live' && isTurnOpen(session.agentState)) {
      setAsking({ value })
      return
    }
    void onSwitch(value, 'wait')
  }
  const answer = (whenBusy: 'wait' | 'interrupt') => {
    const pending = asking
    setAsking(undefined)
    if (pending) void onSwitch(pending.value, whenBusy)
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Switch credential</DropdownMenuLabel>
            <CredentialMenuItems choices={choices} selected={current} onSelect={choose} />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={asking !== undefined}
        onOpenChange={(open) => !open && setAsking(undefined)}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>A turn is running</AlertDialogTitle>
            <AlertDialogDescription>
              Switch when this turn ends, or interrupt it now and continue on the new credential.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="outline" onClick={() => answer('interrupt')}>
              Interrupt now
            </Button>
            <Button type="button" onClick={() => answer('wait')}>
              Wait for the turn to end
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const CHIP_CLASS =
  'inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-[7px] px-1.5 text-[12px] leading-none text-text-faint'

/**
 * The chip, with its data passed in. A start refused for its credential never
 * ran (§9 "Choosing for a session"): it names the credential the person chose,
 * as a readout with nothing to switch, and with none chosen it shows nothing,
 * never "Its own login".
 */
export function SessionCredentialChipView({
  className,
  refused = false,
  ...props
}: SwitchMenuProps & { className?: string; refused?: boolean }): JSX.Element | null {
  const view = props.views?.find((v) => v.id === props.session.credentialId)
  const line = sessionCredentialLine(props.session, view)
  const kind = line.kind ? KIND_WORDS[line.kind] : undefined
  const text = kind && line.kind !== 'own-login' ? `${line.label} · ${kind}` : line.label
  if (refused) {
    if (!props.session.credentialId) return null
    return (
      <span
        data-testid="session-credential-readout"
        title={`Started on ${text}.`}
        className={cn(CHIP_CLASS, className)}
      >
        <KeyRound size={12} className="flex-none" aria-hidden="true" />
        <span className="sr-only">Credential: </span>
        <span className="min-w-0 truncate">{text}</span>
      </span>
    )
  }
  return (
    <SwitchCredentialMenu
      {...props}
      trigger={
        <button
          type="button"
          data-pressable
          aria-label={`Credential: ${text}`}
          title={`Runs on ${text}. Switch credential.`}
          className={cn(CHIP_CLASS, 'hover:text-text-strong', className)}
        >
          <KeyRound size={12} className="flex-none" aria-hidden="true" />
          <span className="min-w-0 truncate">{text}</span>
        </button>
      }
    />
  )
}

/** Run a switch and tell the person how it went. */
export function useSwitchCredential(
  session: Pick<ChipSession, 'sessionId'>,
  views: readonly CredentialView[] | undefined,
  reload: () => void,
): SwitchCredential {
  const trpc = useRequestClient<Trpc>()
  const ui = useUi()
  return async (credentialId, whenBusy) => {
    const label =
      credentialId === null
        ? 'its own login'
        : (views?.find((v) => v.id === credentialId)?.label ?? 'the credential')
    try {
      const result = (await trpc.sessions.switchCredential.mutate({
        sessionId: session.sessionId as SessionId,
        credentialId,
        whenBusy,
      })) as SessionSwitchCredentialOutput
      const outcome = switchOutcome(result, label)
      const open = outcome.openSessionId
      toast(
        outcome.text,
        open ? { action: { label: 'Open', onClick: () => ui.navigateToSession(open) } } : {},
      )
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
}

/** The chip on a session, with its data. */
export const SessionCredentialChip = observer(function SessionCredentialChip({
  session,
  className,
}: {
  session: ChipSession | undefined
  className?: string
}): JSX.Element | null {
  const credentials = useSessionCredentials()
  const acceptsOf = useHarnessAccepts(session?.machineId)
  const onSwitch = useSwitchCredential(
    { sessionId: session?.sessionId as SessionId },
    credentials.views,
    credentials.reload,
  )
  const refusal = usePaneLaunchRefusal(session?.sessionId as SessionId | undefined)
  if (!session?.agentKind || session.agentKind === 'shell') return null
  return (
    <SessionCredentialChipView
      session={session}
      refused={refusal !== undefined}
      views={credentials.views}
      accepts={acceptsOf(session.agentKind)}
      custodianOf={credentials.custodianOf}
      onSwitch={onSwitch}
      {...(className ? { className } : {})}
    />
  )
})
