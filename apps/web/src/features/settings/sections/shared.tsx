/**
 * Shared building blocks for the settings sections (P5d, issue #264): the
 * Section/Row layout primitives, the account/provider label helpers, and the
 * single reusable RoleBackendEditor (SP-6454 B3) used by the sessions,
 * superagent, and background-LLM tabs. Extracted verbatim from SettingsView.tsx.
 */
import type { ApiProvider, HarnessAgent, RoleBackend } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { effortOptionsForModel } from '@/lib/agent-models'
import { issueDefaultAgentKind } from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { useModelCatalog } from '@/lib/use-model-catalog'

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="border-border border-b py-3 last:border-b-0">
      <h3 className="mb-0.5 font-medium text-[13px] text-foreground">{title}</h3>
      {hint && <p className="mb-2 max-w-[60ch] text-[12px] text-muted-foreground">{hint}</p>}
      {children}
    </section>
  )
}

export function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  // Every Row holds exactly one control, but the type system can't prove that to
  // the a11y lint — a div keeps it honest; the visible text still sits beside it.
  return (
    <div className="flex items-center gap-2.5 py-1 text-[13px]">
      <span className="flex-none basis-[140px] text-foreground md:basis-[180px]">{label}</span>
      {children}
    </div>
  )
}

/** One row from `accounts.list` — a native CLI login or a managed API key. */
export interface AccountView {
  id: string
  provider: string
  source: 'native' | 'managed'
  kind?: 'api-key' | 'oauth'
  harness?: string
  identity?: string
  status: 'connected' | 'not-configured'
  comingSoon?: boolean
}

export function providerLabel(p: ApiProvider): string {
  switch (p) {
    case 'openrouter':
      return 'OpenRouter'
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    case 'codex':
      return 'Codex (ChatGPT)'
  }
}

export function harnessAgentLabel(agent: HarnessAgent): string {
  switch (agent) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'grok':
      return 'Grok'
    case 'opencode':
      return 'OpenCode'
    case 'cursor':
      return 'Cursor'
  }
}

export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const NATIVE_HARNESSES: { harness: HarnessAgent; label: string }[] = [
  { harness: 'claude-code', label: 'Claude Code' },
  { harness: 'codex', label: 'Codex (ChatGPT)' },
  { harness: 'grok', label: 'Grok' },
  { harness: 'opencode', label: 'OpenCode' },
  { harness: 'cursor', label: 'Cursor' },
]
const MANAGED_PROVIDERS: { provider: 'anthropic' | 'openai' | 'openrouter'; label: string }[] = [
  { provider: 'anthropic', label: 'Anthropic API' },
  { provider: 'openai', label: 'OpenAI API' },
  { provider: 'openrouter', label: 'OpenRouter API' },
]

/** The account choices for a role. Coding always runs a harness (a native login);
 *  the orchestrator/background roles can also use a managed provider key. */
function accountOptions(role: 'coding' | 'superagent' | 'background') {
  const native = NATIVE_HARNESSES.map((o) => ({ id: `native:${o.harness}`, label: o.label }))
  if (role === 'coding') return native
  return [
    ...native,
    ...MANAGED_PROVIDERS.map((o) => ({ id: `managed:${o.provider}`, label: o.label })),
  ]
}

/**
 * The single reusable editor for any role's backend (SP-6454 B3): pick the
 * account (native CLI login vs managed provider key — "Agent CLI harness" vs
 * "Provider backend (API key or local login)"), then model + effort. Includes
 * the billing explainer the spec demands when picking a harness.
 */
export function RoleBackendEditor({
  role,
  backend,
  accounts,
  onChange,
}: {
  role: 'coding' | 'superagent' | 'background'
  backend: RoleBackend
  accounts: AccountView[]
  onChange: (b: RoleBackend) => void
}): JSX.Element {
  const modelCatalog = useModelCatalog()
  const options = accountOptions(role)
  const accountId = backend.accountId || options[0]!.id
  const isNative = accountId.startsWith('native:')
  const harness = isNative ? (accountId.slice('native:'.length) as HarnessAgent) : undefined
  // Codex is a native login, but the orchestrator/background roles reach it over
  // the Responses API (free-text model), while coding runs it as a CLI harness.
  const harnessForModels =
    harness && !(harness === 'codex' && role !== 'coding') ? harness : undefined
  const agentKind = harnessForModels ? issueDefaultAgentKind(harnessForModels) : undefined
  const showModelEffort =
    (agentKind &&
      effortOptionsForModel(agentKind, backend.model, modelCatalog[agentKind]).length > 0) ||
    accountId === 'native:codex'
  return (
    <>
      <Row label="Account">
        <Select
          value={accountId}
          onValueChange={(value) =>
            onChange({ accountId: value ?? '', model: 'auto', effort: 'auto' })
          }
        >
          <SelectTrigger className="w-full flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => {
              const d = accounts.find((a) => a.id === o.id)
              const status = d?.status === 'connected' ? ` · ${d.identity ?? 'connected'}` : ''
              return (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                  {status}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Model">
        {agentKind ? (
          <ModelPicker
            variant="field"
            agentKind={agentKind}
            value={backend.model}
            onChange={(model) => onChange({ ...backend, model, effort: 'auto' })}
          />
        ) : (
          <Input
            type="text"
            placeholder="auto"
            value={backend.model === 'auto' ? '' : backend.model}
            onChange={(e) => onChange({ ...backend, model: e.target.value || 'auto' })}
          />
        )}
      </Row>
      {showModelEffort && (
        <Row label="Effort">
          {agentKind ? (
            <EffortPicker
              variant="field"
              agentKind={agentKind}
              model={backend.model}
              value={backend.effort}
              onChange={(effort) => onChange({ ...backend, effort })}
            />
          ) : (
            <Select
              value={backend.effort || 'auto'}
              onValueChange={(value) => onChange({ ...backend, effort: value ?? 'auto' })}
            >
              <SelectTrigger className="w-full flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Default (medium)</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Row>
      )}
      {accountId === 'native:claude-code' ? (
        <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-warning">
          Agent CLI harness — Claude Code's programmatic mode (
          <code className="text-[11px]">claude -p</code>).{' '}
          {
            "It uses your Claude Code account and counts against that account's usage/rate limits. API users are billed by token; subscribers consume plan usage."
          }
        </p>
      ) : accountId === 'native:codex' ? (
        <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
          Uses your local ChatGPT login (<code className="text-[11px]">codex login</code> on the
          server) — no API key; it uses your plan's included Codex capacity while limits allow.
        </p>
      ) : isNative ? (
        <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
          Agent CLI harness: Podium runs a real {harness} agent with its own tool belt, using its
          local login on this server.
        </p>
      ) : (
        <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
          Provider backend (API key or local login): billed per token against the key you set under
          API keys.
        </p>
      )}
    </>
  )
}
