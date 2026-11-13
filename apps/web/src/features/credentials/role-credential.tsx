/**
 * THE CREDENTIAL OF A ROLE THAT CALLS A MODEL DIRECTLY (credential management
 * §9 "Direct inference"): the background role names a credential that has a
 * direct-inference route, saved as `roles.<role>.credentialId`. The server's
 * own model calls for the role run on it; with none picked they run on the
 * role's "Runs on" choice.
 *
 * The role's model belongs to the provider that serves it, so a picked
 * credential also decides which models the role's Model row offers
 * ({@link credentialModelSource}, {@link modelFor}).
 */

import { AUTO } from '@podium/client-core/agent-models'
import {
  asCredentialId,
  CREDENTIAL_TYPES,
  type CredentialView,
  INFERENCE_ROUTES,
  isCredentialTypeId,
} from '@podium/model'
import type { HarnessAgent, RoleBackend } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { useCallback } from 'react'
import { useSettingsRecords } from '@/features/settings/record-readers'
import {
  BACKGROUND_MODELS,
  backgroundDefaultModel,
} from '@/features/settings/sections/agent-options'
import { SelectRow } from '@/features/settings/sections/shared'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { identityText, inferenceChoices, typeTitle } from './credential-facts'

/** Where a role's model list comes from: an API provider's list, or a harness login's catalog. */
export type ModelSource =
  | { kind: 'api'; provider: string }
  | { kind: 'login'; harness: HarnessAgent }

/**
 * The model source a picked credential implies: its provider's list for a key
 * the server calls over HTTP, the Codex catalog for a ChatGPT login whose calls
 * run on its machine. `undefined` for a type with no direct-inference route.
 */
export function credentialModelSource(type: string): ModelSource | undefined {
  if (!isCredentialTypeId(type)) return undefined
  const route = INFERENCE_ROUTES[type]
  if (!route) return undefined
  if (route.kind === 'on-machine') return { kind: 'login', harness: 'codex' }
  return { kind: 'api', provider: CREDENTIAL_TYPES[type].provider }
}

const API_MODELS = new Set(
  Object.values(BACKGROUND_MODELS).flatMap((models) => models.map((model) => model.value)),
)

/**
 * The model a role keeps when its model source changes: the stored one when it
 * belongs to the new source, else that source's first model (Auto for a login,
 * whose catalog decides). A model of another provider is never kept.
 */
export function modelFor(source: ModelSource, model: string): string {
  if (source.kind === 'login') return API_MODELS.has(model) ? AUTO : model
  const models = BACKGROUND_MODELS[source.provider] ?? []
  return models.some((choice) => choice.value === model)
    ? model
    : backgroundDefaultModel(source.provider)
}

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
      description="Podium’s own model calls for this role (the issue assistant) run on this credential. With none picked they run on “Runs on” above."
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

/** The person's credentials from `credentials.list`, as the settings page reads them. */
export function useCredentialViews(): readonly CredentialView[] {
  const trpc = useSettingsTrpc()
  const read = useCallback(() => trpc.credentials.list.query(), [trpc])
  const { request } = useSettingsRecords('credential', read, credentialKey)
  // A credential model carries the view's fields; its id is the same value, unbranded.
  return (request?.models ?? []) as unknown as readonly CredentialView[]
}
