import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import { providerLabel, Row, Section } from './shared'

/** Managed provider API keys (stored in Podium's own database on the server). */
export function KeysSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <Section
      title="API keys"
      hint="Stored in Podium's own database on your server — the same trust domain as the shells your agents already run in."
    >
      {(['openrouter', 'anthropic', 'openai'] as const).map((k) => (
        <Row key={k} label={providerLabel(k)}>
          <Input
            type="password"
            autoComplete="off"
            placeholder="not set"
            value={settings.apiKeys[k]}
            onChange={(e) => patch({ apiKeys: { ...settings.apiKeys, [k]: e.target.value } })}
          />
        </Row>
      ))}
    </Section>
  )
}
