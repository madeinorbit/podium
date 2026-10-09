import { type PodiumSettings, resolveRole } from '@podium/runtime'
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
 *  subagent model, start screen) + the auto-continue toggle. */
export function SessionsSection({
  settings,
  accounts,
  patch,
}: {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  const codingHarness = resolveRole(settings, 'coding').harness
  return (
    <>
      <Section
        title="New sessions"
        hint="Which account, model, and effort new coding agents start with. The account is a CLI login on this server."
      >
        {/* Biome mistakes this component prop for an ARIA role attribute. */}
        {/* biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role */}
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
        <Row
          label="Model for subagents"
          description="Applied when the selected harness supports a native subagent-model override."
        >
          <ModelPicker
            variant="field"
            agentKind={codingHarness}
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
              <SelectValue>
                {
                  {
                    native: 'Native terminal',
                    chat: 'Chat view',
                    auto: 'Auto (chat on mobile, terminal on desktop)',
                  }[settings.roles.coding.startScreen]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="native">Native terminal</SelectItem>
              <SelectItem value="chat">Chat view</SelectItem>
              <SelectItem value="auto">Auto (chat on mobile, terminal on desktop)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Match agent theme to Podium"
          description={
            <>
              Seeds each spawned CLI&apos;s per-session theme flag (Claude Code{' '}
              <span className="font-mono">theme: auto</span>, Codex{' '}
              <span className="font-mono">tui.theme=ansi</span>) so agent colours follow the
              issue-tinted terminal. Your global agent config is never modified.
            </>
          }
        >
          <Switch
            checked={settings.roles.coding.seedCliTheme}
            onCheckedChange={(checked) =>
              patch({
                roles: {
                  ...settings.roles,
                  coding: { ...settings.roles.coding, seedCliTheme: checked },
                },
              })
            }
          />
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
