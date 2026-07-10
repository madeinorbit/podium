import type { PodiumSettings } from '@podium/runtime'
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
  return (
    <Section
      title="Background work LLM"
      hint="Summarizing session state, naming conversations, extracting work status. Cheap + fast is the right call here."
    >
      <RoleBackendEditor
        role="background"
        backend={settings.roles.background}
        accounts={accounts}
        onChange={(background) => patch({ roles: { ...settings.roles, background } })}
      />
    </Section>
  )
}
