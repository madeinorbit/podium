/**
 * Add a subscription with its data (credential management §6 way 2; epic Task
 * 9): the person's own machines that are connected, and the app's way to show
 * a terminal.
 */

import { observer } from 'mobx-react-lite'
import { useSettingsMachines } from '@/features/settings/readers'
import { useSettingsClient } from '@/features/settings/stable-access'
import { listeningMachines } from '../add-chatgpt/section'
import type { CredentialDeps } from '../credentials-deps'
import { AddSubscription, type SubscriptionType } from './add-subscription'

export const AddSubscriptionSection = observer(function AddSubscriptionSection({
  deps,
  type,
  credentialId,
  onDone,
}: {
  deps: CredentialDeps
  type?: SubscriptionType
  credentialId?: string
  onDone: () => void
}) {
  const machines = listeningMachines(useSettingsMachines())
  const { navigateToSession } = useSettingsClient()
  return (
    <AddSubscription
      commands={deps.commands}
      deps={deps}
      machines={machines}
      openTerminal={navigateToSession}
      {...(type ? { type } : {})}
      {...(credentialId ? { credentialId } : {})}
      onDone={onDone}
    />
  )
})
