import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Row, Section } from './shared'

/** Git workflow defaults (parent branch, merge style, rebase) + issue assistant. */
export function WorkflowSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <Section title="Git workflow" hint="Defaults for task worktrees and the quick-action buttons.">
      <Row label="Default parent branch">
        <Input
          type="text"
          placeholder="(auto-detect)"
          value={settings.gitWorkflow.defaultParentBranch}
          onChange={(e) =>
            patch({
              gitWorkflow: {
                ...settings.gitWorkflow,
                defaultParentBranch: e.target.value,
              },
            })
          }
        />
      </Row>
      <Row label="Merge style">
        <Select
          value={settings.gitWorkflow.mergeStyle}
          onValueChange={(value) =>
            patch({
              gitWorkflow: {
                ...settings.gitWorkflow,
                mergeStyle: value as 'ff-only' | 'pr' | 'ask',
              },
            })
          }
        >
          <SelectTrigger className="w-full flex-1">
            <SelectValue>
              {
                { 'ff-only': 'FF-only merge', pr: 'Open PR', ask: 'Ask each time' }[
                  settings.gitWorkflow.mergeStyle
                ]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ff-only">FF-only merge</SelectItem>
            <SelectItem value="pr">Open PR</SelectItem>
            <SelectItem value="ask">Ask each time</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Rebase before merge">
        <Switch
          checked={settings.gitWorkflow.autoRebaseBeforeMerge}
          onCheckedChange={(checked) =>
            patch({
              gitWorkflow: {
                ...settings.gitWorkflow,
                autoRebaseBeforeMerge: checked,
              },
            })
          }
        />
      </Row>
      <Row label="Task AI assistant enabled">
        <Switch
          checked={settings.issues.assistantEnabled}
          onCheckedChange={(checked) =>
            patch({ issues: { ...settings.issues, assistantEnabled: checked } })
          }
        />
      </Row>
    </Section>
  )
}
