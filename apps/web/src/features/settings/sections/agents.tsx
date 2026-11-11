import {
  AUTO,
  effortLabel,
  effortOptionsForModel,
  modelLabel,
  modelOptions,
} from '@podium/client-core/agent-models'
import { bundledDescriptorFor, effectiveCatalogModel } from '@podium/harness/browser'
import { type AccountView, asAccountId } from '@podium/model/browser'
import {
  type HarnessAgent,
  type PodiumSettings,
  type RoleBackend,
  resolveRole,
} from '@podium/runtime'
import { ChevronDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { issueAgentDescriptors } from '@/lib/issue-agents'
import { PropertyMenu } from '@/lib/PropertyMenu'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import { useModelCatalogState } from '@/lib/use-model-catalog'
import { SettingsPageSection } from '../settings-anchors'
import {
  agentOptions,
  agentOptionValue,
  BACKGROUND_MODELS,
  backendForAgent,
  backgroundDefaultModel,
  providerNames,
} from './agent-options'
import { ModelAvailabilityWarning } from './model-availability-warning'
import { harnessAgentLabel, Row, Section, SegmentedRow, SelectRow, SwitchRow } from './shared'

interface AgentsProps {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (patch: Partial<PodiumSettings>) => void
}

/** The one home for personal agent choices. Writes keep using SettingsView's
 * per-leaf synced-record writer and its permission/pending/refusal context. */
export const AgentsSection = observer(function AgentsSection({
  settings,
  accounts,
  patch,
}: AgentsProps) {
  const coding = resolveRole(settings, 'coding')
  const { served } = useHarnessDescriptors(undefined)
  const descriptor = issueAgentDescriptors(served).find((d) => d.kind === coding.harness)
  const updateCoding = (backend: Partial<PodiumSettings['roles']['coding']>) =>
    patch({
      roles: { ...settings.roles, coding: { ...settings.roles.coding, ...backend } },
    })
  return (
    <>
      <SettingsPageSection id="sessions">
        <Section
          title="New sessions"
          hint="The default for coding agents you start from the sidebar, a task, or the phone."
        >
          <AgentRoleFields
            roleName="coding"
            backend={settings.roles.coding}
            resolved={coding}
            accounts={accounts}
            onChange={updateCoding}
          />
          {descriptor?.capabilities.subagentModel && (
            <HarnessModelRow
              setting="roles.coding.subagentModel"
              label="Subagent model"
              description={`Model for the helpers ${descriptor.label} starts on its own.`}
              harness={coding.harness}
              value={settings.roles.coding.subagentModel}
              onChange={(subagentModel) => updateCoding({ subagentModel })}
            />
          )}
        </Section>
      </SettingsPageSection>
      <SettingsPageSection id="session-behaviour">
        <Section title="Session behaviour">
          <SegmentedRow
            setting="roles.coding.startScreen"
            label="Open new sessions in"
            description="Auto shows chat on a phone and the terminal on a computer."
            value={settings.roles.coding.startScreen}
            options={[
              { value: 'native', label: 'Terminal' },
              { value: 'chat', label: 'Chat' },
              { value: 'auto', label: 'Auto' },
            ]}
            onChange={(startScreen) => updateCoding({ startScreen })}
          />
          <SwitchRow
            setting="roles.coding.seedCliTheme"
            label="Match agent colours to Podium"
            description="Starts each CLI in a theme that fits the current Podium theme. Your own agent config is never changed."
            value={settings.roles.coding.seedCliTheme}
            onChange={(seedCliTheme) => updateCoding({ seedCliTheme })}
          />
          <SwitchRow
            setting="autoContinue.enabled"
            label="Keep going after errors"
            description="When an agent stops on a rate limit or server error, Podium sends “continue” again after a growing pause (up to 5 min). It can keep an agent spending tokens for hours."
            value={settings.autoContinue.enabled}
            onChange={(enabled) => patch({ autoContinue: { ...settings.autoContinue, enabled } })}
          />
        </Section>
      </SettingsPageSection>
      <SettingsPageSection id="superagent">
        <Section
          title="Superagent"
          hint="The orchestrator you talk to in the Flight Deck. It plans, starts and checks on other agents."
        >
          <AgentRoleFields
            roleName="superagent"
            backend={settings.roles.superagent}
            resolved={resolveRole(settings, 'superagent')}
            accounts={accounts}
            onChange={(superagent) => patch({ roles: { ...settings.roles, superagent } })}
          />
        </Section>
      </SettingsPageSection>
      <SettingsPageSection id="workllm">
        <BackgroundModelSection settings={settings} accounts={accounts} patch={patch} />
      </SettingsPageSection>
    </>
  )
})

export const AgentRoleFields = observer(function AgentRoleFields({
  roleName,
  backend,
  resolved,
  accounts,
  onChange,
}: {
  roleName: 'coding' | 'superagent'
  backend: RoleBackend
  resolved: { accountId: RoleBackend['accountId']; harness: HarnessAgent }
  accounts: readonly AccountView[]
  onChange: (backend: RoleBackend) => void
}) {
  const { served } = useHarnessDescriptors(undefined)
  const { catalog } = useModelCatalogState()
  const options = agentOptions(accounts, roleName === 'superagent', served)
  const value = agentOptionValue(resolved.accountId, resolved.harness)
  const selected = options.find((option) => option.value === value)
  const machineLogin =
    resolved.accountId === `native:${resolved.harness}` &&
    options.some(
      (option) =>
        option.group === 'Signed in on your machines' && option.harness === resolved.harness,
    )
  const label =
    issueAgentDescriptors(served).find((d) => d.kind === resolved.harness)?.label ??
    resolved.harness
  const groups = (['Signed in on your machines', 'Using your API key', 'Shared with you'] as const)
    .map((group) => ({ label: group, options: options.filter((option) => option.group === group) }))
    .filter((group) => group.options.length > 0)
  const changeModel = (model: string) => {
    const efforts = catalog[resolved.harness]?.find((entry) => entry.value === model)?.efforts
    onChange({
      ...backend,
      model,
      effort: efforts?.includes(backend.effort) ? backend.effort : AUTO,
    })
  }
  const effective = effectiveCatalogModel(
    issueAgentDescriptors(served).find((d) => d.kind === resolved.harness),
    backend.model,
    catalog[resolved.harness],
  )
  const effortOptions = effortOptionsForModel(
    resolved.harness,
    effective,
    catalog[resolved.harness],
    served,
  )
  return (
    <>
      <SelectRow
        setting={[
          `roles.${roleName}.accountId`,
          `roles.${roleName}.harness`,
          `roles.${roleName}.model`,
          `roles.${roleName}.effort`,
        ]}
        label="Agent"
        description={
          selected?.help ??
          (machineLogin
            ? 'Uses the login already on each target machine. Usage counts against that subscription or account.'
            : 'This agent is not connected. Sign in or add a key under AI accounts. Your saved choice is kept.')
        }
        value={value}
        options={
          selected
            ? []
            : [
                {
                  value,
                  label,
                  hint: machineLogin ? 'Login on the target machine' : 'Not connected',
                  disabled: true,
                },
              ]
        }
        groups={groups}
        onChange={(value) => {
          const next = options.find((option) => option.value === value)
          if (next)
            onChange(backendForAgent(backend, resolved.harness, next, catalog[next.harness]))
        }}
      />
      <HarnessModelRow
        setting={[`roles.${roleName}.model`, `roles.${roleName}.effort`]}
        label="Model"
        harness={resolved.harness}
        value={backend.model}
        onChange={changeModel}
        description={
          <ModelAvailabilityWarning
            harness={resolved.harness}
            model={backend.model}
            descriptors={served}
          />
        }
      />
      <Row
        setting={`roles.${roleName}.effort`}
        label="Effort"
        description={
          backend.effort !== AUTO &&
          !effortOptions.some((option) => option.value === backend.effort)
            ? `Saved effort: ${backend.effort}. This model has not reported that level.`
            : 'How long the model thinks before acting.'
        }
        readOnlyValue={effortLabel(resolved.harness, backend.effort)}
      >
        <fieldset aria-label="Effort" className="settings-segmented">
          {(effortOptions.length ? effortOptions : [{ value: AUTO, label: 'Auto' }]).map(
            (option) => (
              <Button
                key={option.value}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={(backend.effort || AUTO) === option.value}
                className={
                  backend.effort === option.value
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground'
                }
                onClick={() => onChange({ ...backend, effort: option.value })}
              >
                {option.label}
              </Button>
            ),
          )}
        </fieldset>
      </Row>
    </>
  )
})

function HarnessModelRow({
  setting,
  label,
  description,
  harness,
  value,
  onChange,
  background = false,
}: {
  setting: string | readonly string[]
  label: string
  description?: ReactNode
  harness: HarnessAgent
  value: string
  onChange: (value: string) => void
  background?: boolean
}) {
  const { catalog, status } = useModelCatalogState()
  const { served } = useHarnessDescriptors(undefined)
  const descriptor = issueAgentDescriptors(served).find((d) => d.kind === harness)
  // Codex's one-shot API uses the bundled catalog head on the server.
  const effective = background
    ? effectiveCatalogModel(bundledDescriptorFor(harness), AUTO)
    : effectiveCatalogModel(descriptor, AUTO, catalog[harness])
  const autoLabel = effective
    ? `Auto · ${modelLabel(harness, effective, background ? bundledDescriptorFor(harness)?.catalog.models : catalog[harness]?.length ? catalog[harness] : descriptor?.catalog.models, served)}`
    : 'Auto · Agent chooses'
  return (
    <Row
      setting={setting}
      label={label}
      description={description}
      readOnlyValue={
        value === AUTO ? autoLabel : modelLabel(harness, value, catalog[harness], served)
      }
    >
      <PropertyMenu
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-between font-normal"
            aria-label={label}
          >
            <span className="truncate">
              {!value || value === AUTO
                ? autoLabel
                : modelLabel(harness, value, catalog[harness], served)}
            </span>
            <ChevronDown size={14} aria-hidden="true" className="shrink-0 opacity-50" />
          </Button>
        }
        options={modelOptions(harness, catalog[harness], served).map((option) =>
          option.value === AUTO ? { ...option, label: autoLabel } : option,
        )}
        selectedValue={value || AUTO}
        allowFreeText
        placeholder="Model name…"
        footnote={
          !catalog[harness]?.length
            ? status === 'loading'
              ? 'Loading models from this machine…'
              : 'This machine has not reported its models. Auto lets the agent choose.'
            : undefined
        }
        onSelect={onChange}
      />
    </Row>
  )
}

const BackgroundModelSection = observer(function BackgroundModelSection({
  settings,
  accounts,
  patch,
}: AgentsProps) {
  const resolved = resolveRole(settings, 'background')
  const backend = settings.roles.background
  const selected = accounts.find((account) => account.id === resolved.accountId)
  const native = resolved.accountId.startsWith('native:')
  const provider = selected?.provider ?? resolved.provider ?? 'openrouter'
  const available = accounts.filter(
    (account) =>
      account.status === 'connected' &&
      ((account.source === 'managed' &&
        account.kind !== 'oauth' &&
        Boolean(BACKGROUND_MODELS[account.provider])) ||
        (account.source === 'native' && account.harness === 'codex')),
  )
  const labelFor = (account: AccountView) =>
    account.source === 'native'
      ? 'Codex login'
      : (providerNames[account.provider] ?? account.provider)
  const hintFor = (account: AccountView) =>
    account.source === 'native'
      ? [account.identity, account.machines?.join(', ')].filter(Boolean).join(' · ')
      : account.credentialSource === 'shared'
        ? `${account.sharedBy || 'Another member'}’s key`
        : 'Your key'
  const groups = [
    {
      label: 'Your API keys',
      filter: (account: AccountView) =>
        account.source === 'managed' && account.credentialSource !== 'shared',
    },
    {
      label: 'Shared with you',
      filter: (account: AccountView) =>
        account.source === 'managed' && account.credentialSource === 'shared',
    },
    {
      label: 'Signed in on your machines',
      filter: (account: AccountView) => account.source === 'native',
    },
  ]
    .map((group) => ({
      label: group.label,
      options: available.filter(group.filter).map((account) => ({
        value: account.id,
        label: labelFor(account),
        hint: hintFor(account),
      })),
    }))
    .filter((group) => group.options.length > 0)
  const change = (value: Partial<RoleBackend>) =>
    patch({ roles: { ...settings.roles, background: { ...backend, ...value } } })
  const models = BACKGROUND_MODELS[provider] ?? []
  const defaultModel = backgroundDefaultModel(provider)
  const modelValue = backend.model || defaultModel
  const machineLogin =
    native &&
    resolved.accountId === `native:${resolved.harness}` &&
    available.some((account) => account.source === 'native' && account.harness === resolved.harness)
  const serverAi = native
    ? (selected?.serverAi ??
      (machineLogin
        ? available.find((account) => account.harness === resolved.harness && account.serverAi)
            ?.serverAi
        : undefined))
    : undefined
  const lastError = serverAi?.lastError
  return (
    <Section
      title="Background model"
      hint="Small jobs Podium runs for you: naming sessions, summarising tasks, reading what an agent is doing. Cheap and fast is right here."
    >
      <SelectRow
        setting={[
          'roles.background.accountId',
          'roles.background.harness',
          'roles.background.model',
          'roles.background.effort',
        ]}
        label="Runs on"
        value={resolved.accountId}
        options={
          available.some((account) => account.id === resolved.accountId)
            ? []
            : [
                {
                  value: resolved.accountId,
                  label: selected
                    ? labelFor(selected)
                    : native
                      ? `${harnessAgentLabel(resolved.harness)} login`
                      : (providerNames[provider] ?? provider),
                  hint: machineLogin ? 'Login on the target machine' : 'Not connected',
                  disabled: true,
                },
              ]
        }
        groups={groups}
        description={
          selected?.credentialSource === 'shared'
            ? `Uses the key ${selected.sharedBy || 'another member'} shared because you have no ${providerNames[provider] ?? provider} key of your own. Billed per token to their key.`
            : native
              ? 'Uses the ChatGPT login on your machines. Usage counts against that subscription.'
              : 'Billed per token to your key. Manage your keys under AI accounts.'
        }
        onChange={(id) => {
          const account = available.find((account) => account.id === id)
          if (!account) return
          const nextNative = account.source === 'native'
          const nextModels = BACKGROUND_MODELS[account.provider] ?? []
          change({
            accountId: asAccountId(id),
            harness: undefined,
            effort: AUTO,
            model: nextNative
              ? AUTO
              : nextModels.some((model) => model.value === backend.model)
                ? backend.model
                : backgroundDefaultModel(account.provider),
          })
        }}
      />
      {native ? (
        <HarnessModelRow
          setting="roles.background.model"
          label="Model"
          harness={resolved.harness}
          value={backend.model}
          onChange={(model) => change({ model })}
          background
        />
      ) : (
        <SelectRow
          setting="roles.background.model"
          label="Model"
          value={modelValue}
          options={[
            ...models,
            ...(!models.some((model) => model.value === modelValue)
              ? [
                  {
                    value: modelValue,
                    label: modelValue === AUTO ? 'Auto (saved; choose a model)' : modelValue,
                    disabled: modelValue === AUTO,
                  },
                ]
              : []),
          ]}
          onChange={(model) => change({ model })}
        />
      )}
      {lastError && (
        <Row
          label="Status"
          description={
            <>
              {serverAi?.machineName && (
                <span className="block">Uses the login on {serverAi.machineName}.</span>
              )}
              <span className="block text-warning">Last error: {lastError}</span>
            </>
          }
          readOnly
          readOnlyValue="Error recorded"
        />
      )}
    </Section>
  )
})
