/**
 * THE CREDENTIAL OF A ROLE THAT CALLS A MODEL DIRECTLY (credential management
 * §9 "Direct inference"): the background role names a credential that has a
 * direct-inference route, saved as `roles.<role>.credentialId`.
 *
 * The server reads that field from epic Task 12 on; until then the role keeps
 * running on its account choice. So this row never presents the saved choice
 * as what is in use, and says so.
 */

import type { CredentialView } from '@podium/model'
import { asCredentialId } from '@podium/model'
import type { RoleBackend } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { useCallback } from 'react'
import { useSettingsRecords } from '@/features/settings/record-readers'
import { SelectRow } from '@/features/settings/sections/shared'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { identityText, inferenceChoices, typeTitle } from './credential-facts'

const NONE = 'none'

export const RoleCredentialSelect = observer(function RoleCredentialSelect({
  roleName,
  views,
  backend,
  onChange,
}: {
  roleName: 'background' | 'superagent'
  views: readonly CredentialView[]
  backend: RoleBackend
  onChange: (backend: RoleBackend) => void
}) {
  const choices = inferenceChoices(views)
  const saved = backend.credentialId
  const value = saved ?? NONE
  const stale = saved !== undefined && !choices.some((view) => view.id === saved)
  return (
    <SelectRow
      setting={`roles.${roleName}.credentialId`}
      label="Credential"
      description="Saved for a coming update, which runs these jobs on the credential you pick. Until then they run on “Runs on” above."
      value={value as string}
      options={[
        { value: NONE, label: 'None picked' },
        ...choices.map((view) => ({
          value: view.id as string,
          label: view.label,
          hint: [typeTitle(view.type), identityText(view)].filter(Boolean).join(' · '),
        })),
        ...(stale ? [{ value: value as string, label: 'Not available', disabled: true }] : []),
      ]}
      onChange={(next) => {
        const { credentialId: _dropped, ...rest } = backend
        onChange(next === NONE ? rest : { ...rest, credentialId: asCredentialId(next) })
      }}
    />
  )
})

const credentialKey = (row: CredentialView) => row.id as string

/** The select with its data: the person's credentials from `credentials.list`. */
export const RoleCredentialRow = observer(function RoleCredentialRow(props: {
  roleName: 'background' | 'superagent'
  backend: RoleBackend
  onChange: (backend: RoleBackend) => void
}) {
  const trpc = useSettingsTrpc()
  const read = useCallback(() => trpc.credentials.list.query(), [trpc])
  const { request } = useSettingsRecords('credential', read, credentialKey)
  // A credential model carries the view's fields; its id is the same value, unbranded.
  const views = (request?.models ?? []) as unknown as readonly CredentialView[]
  return <RoleCredentialSelect {...props} views={views} />
})
