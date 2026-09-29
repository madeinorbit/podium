import { bundledDescriptorFor, effectiveCatalogModel } from '@podium/harness/browser'
import { type PodiumSettings, resolveRole } from '@podium/runtime'
import type { JSX } from 'react'
import { type AccountView, RoleBackendEditor, Section } from './shared'

/** Backend for the cheap background work LLM (summaries, naming, status). */
export function WorkLlmSection({
  settings,
  accounts,
  patch,
}: {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  // What the call actually runs on (POD-4805): the role's resolved account —
  // never the picker's first-option fallback — so an unset role shows the
  // server truth (managed:openrouter) instead of a Codex login it will not spend.
  const role = resolveRole(settings, 'background')
  // The model the call actually sends (POD-4805): a stored 'auto' on a
  // native-backed API role resolves through the same catalog function as the
  // server's one-shot client, so the displayed model and the called model
  // cannot disagree. Shown only when it settles to a concrete slug.
  const nativeBackedApi = role.execution === 'api' && role.accountId.startsWith('native:')
  const effective =
    nativeBackedApi && (role.model === 'auto' || !role.model)
      ? effectiveCatalogModel(bundledDescriptorFor(role.harness), role.model)
      : undefined
  // The background role's last refusal text (POD-4805), when the issue
  // assistant has recorded one: it rides on the spent login's account row, so
  // a refused server-AI call says why here instead of failing silently.
  const lastError = accounts.find((a) => a.serverAi?.lastError)?.serverAi?.lastError
  return (
    <Section
      title="Background work LLM"
      hint="Summarizing session state, naming conversations, extracting work status. Cheap + fast is the right call here."
    >
      {effective && (
        <p className="settings-prose mb-4">Effective model: {effective} (Model is Auto)</p>
      )}
      {lastError && (
        <p className="settings-prose text-warning mb-4">Background LLM last failed: {lastError}</p>
      )}
      <RoleBackendEditor
        role="background"
        backend={settings.roles.background}
        accounts={accounts}
        fallbackAccountId={role.accountId}
        onChange={(background) => patch({ roles: { ...settings.roles, background } })}
      />
    </Section>
  )
}
