import type { CredentialView } from '@podium/model'
import { BadgeCheck, KeyRound, Users } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { EntityRow } from '@/features/settings/sections/shared'
import { identityText, isSubscription, statusLines, typeTitle } from './credential-facts'
import type { CredentialDeps } from './credentials-deps'
import { FoundLoginActions, FoundLoginStatus } from './found-login-controls'

const TONE_CLASS = { ok: undefined, warn: 'text-warning', muted: undefined } as const

/**
 * One credential in the list. A credential granted for `use` opens nothing and
 * offers no action: it names its owner, and only the owner can change it.
 */
export const CredentialRow = observer(function CredentialRow({
  view,
  deps,
  onOpen,
}: {
  view: CredentialView
  deps: CredentialDeps
  onOpen: (view: CredentialView) => void
}) {
  const lines = statusLines(view, {
    now: deps.now(),
    ownerName: deps.nameOf,
    machineName: deps.machineName,
  })
  const identity = identityText(view)
  const leading =
    view.access === 'use' ? (
      <Users size={16} />
    ) : isSubscription(view.type) ? (
      <BadgeCheck size={16} />
    ) : (
      <KeyRound size={16} />
    )
  return (
    <EntityRow
      leading={leading}
      title={view.label}
      pills={
        <>
          <span className="settings-micro rounded-full bg-chip px-2 py-0.5">
            {typeTitle(view.type)}
          </span>
          {identity && (
            <span className="settings-micro min-w-0 max-w-full break-words font-mono">
              {identity}
            </span>
          )}
        </>
      }
      subtitle={
        <div>
        <span className="flex flex-wrap gap-x-2">
          {lines.map((line) => (
            <span key={line.text} className={TONE_CLASS[line.tone]}>
              {line.text}
            </span>
          ))}
        </span>
        <FoundLoginStatus view={view} />
        </div>
      }
      trailing={view.nativeLogin && view.access === 'owner' ? <FoundLoginActions view={view} deps={deps} /> : undefined}
      onClick={view.access === 'use' ? undefined : () => onOpen(view)}
    />
  )
})
