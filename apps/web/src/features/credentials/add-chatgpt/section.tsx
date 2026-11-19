/**
 * Sign in with ChatGPT with its data (credential management §11; epic Task
 * 14): the person's own machines that are online, any of which can listen for
 * the browser's return.
 */

import { observer } from 'mobx-react-lite'
import { useSettingsMachines } from '@/features/settings/readers'
import type { CredentialDeps } from '../credentials-deps'
import { ChatgptSignIn, type ListeningMachine } from './chatgpt-sign-in'

/** Machines the person looks after that are connected now. */
export function listeningMachines(
  machines: readonly { id: string; name: string; owned?: boolean; online?: boolean }[],
): ListeningMachine[] {
  return machines
    .filter((machine) => machine.owned === true && machine.online === true)
    .map((machine) => ({ id: machine.id, name: machine.name }))
}

export const ChatgptSignInSection = observer(function ChatgptSignInSection({
  deps,
  credentialId,
  label,
  onDone,
}: {
  deps: CredentialDeps
  credentialId?: string
  label?: string
  onDone: () => void
}) {
  const machines = listeningMachines(useSettingsMachines())
  return (
    <ChatgptSignIn
      commands={deps.commands}
      deps={deps}
      machines={machines}
      {...(credentialId ? { credentialId } : {})}
      {...(label ? { label } : {})}
      onDone={onDone}
    />
  )
})
