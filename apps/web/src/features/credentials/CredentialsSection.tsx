/**
 * The credentials page with its data: `credentials.list` into the shared
 * credential models, the member roster for names, the machines the person
 * may send a credential to, and the served harness descriptors. Admin rights
 * change nothing here: every person sees and manages their own (§12).
 */

import {
  type MemberRoster,
  type MemberRosterAnswer,
  memberRoster,
} from '@podium/client-graph/member-roster'
import type { CredentialView } from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { useSettingsMachines } from '@/features/settings/readers'
import { useSettingsRecords } from '@/features/settings/record-readers'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { memberRequest } from '@/features/setup/member-api'
import { issueAgentDescriptors } from '@/lib/issue-agents'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import './add-chatgpt/register'
import { CredentialsView } from './CredentialsView'
import { sendableMachines } from './credential-facts'
import type { CredentialDeps } from './credentials-deps'
import { MachineLogins } from './machine-logins'

const credentialKey = (row: CredentialView) => row.id as string

/** Names and roles of active members, read once the page opens. */
function useRoster(open: boolean): MemberRoster | null {
  const pool = useWorklistPool()
  const roster = pool ? memberRoster(pool) : null
  useEffect(() => {
    if (!open || !roster) return
    const origin = serverConfig(window.location).httpOrigin
    void roster.read(() => memberRequest<MemberRosterAnswer>(origin, 'directory'))
  }, [roster, open])
  return roster
}

export const CredentialsSection = observer(function CredentialsSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (patch: Partial<PodiumSettings>) => void
}) {
  const trpc = useSettingsTrpc()
  const read = useCallback(() => trpc.credentials.list.query(), [trpc])
  const { request, reload } = useSettingsRecords('credential', read, credentialKey)
  // A credential model carries the view's fields; its id is the same value, unbranded.
  const views = request?.models as unknown as readonly CredentialView[] | undefined
  const roster = useRoster(true)
  const machines = useSettingsMachines()
  const { served } = useHarnessDescriptors(undefined)
  const descriptors = useMemo(() => issueAgentDescriptors(served), [served])
  const members = roster?.members
  const currentUserId = roster?.currentMemberId
  const deps = useMemo<CredentialDeps>(
    () => ({
      commands: trpc.credentials,
      reload: () => void reload(),
      currentUserId,
      people: (members ?? []).map((member) => ({ id: member.id, name: member.displayName })),
      nameOf: (userId) => members?.find((member) => member.id === userId)?.displayName,
      machineName: (machineId) =>
        machines.find((machine) => machine.id === machineId)?.name ?? 'a machine',
      sendable: sendableMachines(machines),
      now: () => Date.now(),
    }),
    [trpc, reload, currentUserId, members, machines],
  )
  return (
    <CredentialsView
      views={views}
      loadError={request?.error ?? null}
      deps={deps}
      descriptors={descriptors}
      settings={settings}
      patch={patch}
    >
      <MachineLogins />
    </CredentialsView>
  )
})
