import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import { Row, Section } from './shared'

/** External integrations (Linear). */
export function IntegrationsSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <Section title="Integrations" hint="Linear lets the superagent pick up, add, and move tickets.">
      <Row label="Linear API key">
        <Input
          type="password"
          autoComplete="off"
          placeholder="lin_api_…"
          value={settings.integrations.linearApiKey}
          onChange={(e) =>
            patch({
              integrations: { ...settings.integrations, linearApiKey: e.target.value },
            })
          }
        />
      </Row>
    </Section>
  )
}
