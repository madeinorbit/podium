/**
 * WHAT A SESSION SAYS ABOUT ITS CREDENTIAL WHEN SOMETHING IS WRONG
 * (credential management §7 "Health and renewal", §9 "Launching").
 *
 * - The harness answered on another identity than the one chosen
 *   (`credentialMismatch`): a working session that may bill someone else, so
 *   it is said, with both identities and the switch.
 * - The credential needs attention: why, with "Renew" and "Switch credential".
 */

import { useUi } from '@podium/client-core/react'
import type { AcceptLine, CustodianOf } from '@podium/client-graph/session-credential-facts'
import type { CredentialMismatch, CredentialView, EffectiveAuth } from '@podium/model'
import { TriangleAlert } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { issueAgentLabel } from '@/lib/issue-agents'
import {
  type ChipSession,
  type SwitchCredential,
  SwitchCredentialMenu,
  useSwitchCredential,
} from './SessionCredentialChip'
import { useHarnessAccepts, useSessionCredentials } from './use-session-credentials'

export type NoticeSession = ChipSession & { credentialMismatch?: CredentialMismatch }

const METHOD_WORDS: Readonly<Record<EffectiveAuth['method'], string>> = {
  subscription: 'a subscription',
  'api-key': 'an API key',
  token: 'a token',
  unknown: 'another login',
}

/** The identity a harness reported, in words. */
function reportedText(reported: EffectiveAuth): string {
  if (reported.email) return reported.email
  const method = METHOD_WORDS[reported.method]
  return reported.fingerprint ? `${method} (${reported.fingerprint})` : method
}

function noticeText(session: NoticeSession, view: CredentialView | undefined): string | undefined {
  const mismatch = session.credentialMismatch
  if (mismatch) {
    const chosen = view?.label ?? mismatch.chosen.email ?? 'the chosen credential'
    const harness = issueAgentLabel(session.agentKind ?? '')
    return `This session was started on ${chosen}, but ${harness} reports ${reportedText(mismatch.reported)}. It may bill another account.`
  }
  if (view?.status === 'attention') {
    return `${view.label} needs attention: ${view.statusReason ?? 'it stopped working.'}`
  }
  return undefined
}

export function SessionCredentialNoticeView({
  session,
  views,
  accepts,
  custodianOf,
  onSwitch,
  onRenew,
}: {
  session: NoticeSession
  views: readonly CredentialView[] | undefined
  accepts: readonly AcceptLine[]
  custodianOf: CustodianOf
  onSwitch: SwitchCredential
  onRenew: () => void
}): JSX.Element | null {
  const view = views?.find((v) => v.id === session.credentialId)
  const text = noticeText(session, view)
  if (!text) return null
  const attention = !session.credentialMismatch && view?.status === 'attention'
  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <TriangleAlert size={13} className="flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      {attention ? (
        <Button type="button" size="xs" variant="outline" onClick={onRenew}>
          Renew
        </Button>
      ) : null}
      <SwitchCredentialMenu
        session={session}
        views={views}
        accepts={accepts}
        custodianOf={custodianOf}
        onSwitch={onSwitch}
        trigger={
          <Button type="button" size="xs" variant="outline">
            Switch credential
          </Button>
        }
      />
    </div>
  )
}

/** Opens Settings on the credentials page, where a credential is renewed. */
export function useOpenCredentials(): () => void {
  const ui = useUi()
  return () => {
    ui.setView('settings')
    ui.setSettingsTab('credentials')
  }
}

export const SessionCredentialNotice = observer(function SessionCredentialNotice({
  session,
}: {
  session: NoticeSession
}): JSX.Element | null {
  const credentials = useSessionCredentials()
  const acceptsOf = useHarnessAccepts(session.machineId)
  const onSwitch = useSwitchCredential(session, credentials.views, credentials.reload)
  const openCredentials = useOpenCredentials()
  if (!session.agentKind || session.agentKind === 'shell') return null
  return (
    <SessionCredentialNoticeView
      session={session}
      views={credentials.views}
      accepts={acceptsOf(session.agentKind)}
      custodianOf={credentials.custodianOf}
      onSwitch={onSwitch}
      onRenew={openCredentials}
    />
  )
})
