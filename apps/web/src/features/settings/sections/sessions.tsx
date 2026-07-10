import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ModelPicker } from '@/lib/ModelEffortPicker'
import { type AccountView, RoleBackendEditor, Row, Section } from './shared'

/** New-session defaults (which account/model/effort coding agents start with,
 *  subagent strategy, start screen) + the auto-continue toggle. */
export function SessionsSection({
  settings,
  accounts,
  patch,
}: {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <>
      <Section
        title="New sessions"
        hint="Which account, model, and effort new coding agents start with. The account is a CLI login on this server."
      >
        <RoleBackendEditor
          role="coding"
          backend={settings.roles.coding}
          accounts={accounts}
          onChange={(b) =>
            patch({
              roles: { ...settings.roles, coding: { ...settings.roles.coding, ...b } },
            })
          }
        />
        <Row label="Model for subagents">
          <ModelPicker
            variant="field"
            agentKind="claude-code"
            value={settings.roles.coding.subagentModel}
            onChange={(subagentModel) =>
              patch({
                roles: {
                  ...settings.roles,
                  coding: { ...settings.roles.coding, subagentModel },
                },
              })
            }
          />
        </Row>
        <Row label="Subagents">
          <Select
            value={settings.roles.coding.subagentStrategy}
            onValueChange={(value) => {
              if (value !== 'builtin') return // 'podium' is coming soon
              patch({
                roles: {
                  ...settings.roles,
                  coding: { ...settings.roles.coding, subagentStrategy: 'builtin' },
                },
              })
            }}
          >
            <SelectTrigger className="w-full flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="builtin">Built-in (the harness's own)</SelectItem>
              <SelectItem value="podium" disabled>
                Coordinate via Podium — coming soon
              </SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
          Built-in subagents share the harness and are the best choice today. Podium-coordinated
          subagents (needed to run a different harness or get cross-harness visibility) are coming
          soon.
        </p>
        <Row label="New session opens on">
          <Select
            value={settings.roles.coding.startScreen}
            onValueChange={(value) =>
              patch({
                roles: {
                  ...settings.roles,
                  coding: {
                    ...settings.roles.coding,
                    startScreen: value as 'native' | 'chat' | 'auto',
                  },
                },
              })
            }
          >
            <SelectTrigger className="w-full flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="native">Native terminal</SelectItem>
              <SelectItem value="chat">Chat view</SelectItem>
              <SelectItem value="auto">Auto (chat on mobile, terminal on desktop)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>
      <Section
        title="Auto-continue on errors"
        hint="When an agent stops on a retryable error (rate limit, server error), keep re-sending “continue” on an increasing delay (up to 5 min) until it recovers. Heads up: this can keep an agent running indefinitely and consuming tokens."
      >
        <Row label="Enabled">
          <Switch
            checked={settings.autoContinue.enabled}
            onCheckedChange={(checked) =>
              patch({ autoContinue: { ...settings.autoContinue, enabled: checked } })
            }
          />
        </Row>
      </Section>
    </>
  )
}
