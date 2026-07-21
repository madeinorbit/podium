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
    <section className="mt-6 border-hairline-soft border-t pt-4 first:mt-0 first:border-t-0 first:pt-1">
      <h3 className="mb-0.5 font-semibold text-[12.5px] text-text-strong">{title}</h3>
      {hint && <p className="mb-1.5 max-w-[58ch] text-[11.5px] text-text-dim">{hint}</p>}
      {children}
    </section>
  )
}

export function Row({
  label,
  description,
  children,
}: {
  label: string
  /** The row's own explanation — lives under the label, never as a detached
   *  paragraph between rows (POD-127 F3). */
  description?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  // Every Row holds exactly one control, but the type system can't prove that to
  // the a11y lint — a div keeps it honest; the visible text still sits beside it.
  return (
    <div className="settings-row grid grid-cols-1 gap-1.5 py-2.5 text-[13px] md:grid-cols-[minmax(0,1fr)_240px] md:items-center md:gap-4">
      <div className="min-w-0">
        <span className="text-[12.5px] text-foreground">{label}</span>
        {description && (
          <p className="mt-0.5 max-w-[44ch] text-[11px] text-text-dim leading-normal">
            {description}
          </p>
        )}
      </div>
      <div className="flex w-full min-w-0 items-center md:justify-end">{children}</div>
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
  /** Managed only: 'stored' = the accounts table (Podium injects it, and can drop
   *  it again); 'legacy' = a pre-hub Settings → API keys value the server has no
   *  row for, so it cannot be disconnected from here. */
  credentialSource?: 'stored' | 'legacy'
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

/**
 * Managed credentials a CODING session can actually run on (#216), and the
 * harnesses each one can authenticate.
 *
 * A coding session always runs a harness; a managed account only supplies the
 * credential it authenticates WITH. So the pairing must be one the CLI really
 * accepts — credentialEnv() decides that: an anthropic key becomes
 * ANTHROPIC_API_KEY and the Claude setup-token becomes CLAUDE_CODE_OAUTH_TOKEN
 * (both read by Claude Code); an openai key becomes OPENAI_API_KEY (read by
 * Codex). An OPENROUTER_API_KEY authenticates none of the coding CLIs we ship,
 * so `managed:openrouter` is deliberately NOT offered here — presenting it would
 * spawn an agent that silently falls back to whatever login the machine happens
 * to have. It stays available for the API-backed background role below.
 */
export const MANAGED_CODING_ACCOUNTS: {
  id: string
  label: string
  harnesses: HarnessAgent[]
}[] = [
  {
    id: 'managed:claude-oauth',
    label: 'Claude subscription (managed)',
    harnesses: ['claude-code'],
  },
  { id: 'managed:anthropic', label: 'Anthropic API key (managed)', harnesses: ['claude-code'] },
  { id: 'managed:openai', label: 'OpenAI API key (managed)', harnesses: ['codex'] },
]

/** The harnesses a managed account can drive for the coding role; [] when it can
 *  drive none (so it is never offered). */
export function managedCodingHarnesses(accountId: string): HarnessAgent[] {
  return MANAGED_CODING_ACCOUNTS.find((a) => a.id === accountId)?.harnesses ?? []
}

/** Only offer execution paths each role can actually run today. CODING runs a
 *  native harness, or a MANAGED credential injected into that harness's spawn
 *  (#216). The superagent runs a native harness. Background work is API-only:
 *  managed provider keys plus Codex's local-login Responses API. */
export function accountOptions(
  role: 'coding' | 'superagent' | 'background',
): { id: string; label: string }[] {
  const native = NATIVE_HARNESSES.map((o) => ({ id: `native:${o.harness}`, label: o.label }))
  if (role === 'coding') {
    return [...native, ...MANAGED_CODING_ACCOUNTS.map((o) => ({ id: o.id, label: o.label }))]
  }
  if (role === 'superagent') return native
  return [
    { id: 'native:codex', label: 'Codex (ChatGPT)' },
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
  const accountId = backend.accountId || options[0]?.id || 'native:claude-code'
  const selectedOption = options.find((option) => option.id === accountId)
  const selectedAccount = accounts.find((account) => account.id === accountId)
  const selectedStatus =
    selectedAccount?.status === 'connected' ? ` · ${selectedAccount.identity ?? 'connected'}` : ''
  const selectedLabel = selectedOption ? `${selectedOption.label}${selectedStatus}` : accountId
  const isNative = accountId.startsWith('native:')
  const nativeHarness = isNative ? (accountId.slice('native:'.length) as HarnessAgent) : undefined
  // A managed credential for the coding role needs a harness to run it on: the
  // account says WHAT authenticates, `harness` says WHICH CLI. resolveRole() reads
  // exactly this field, so it must be written — without it the role is ambiguous.
  const codingHarnesses = role === 'coding' && !isNative ? managedCodingHarnesses(accountId) : []
  const managedHarness =
    codingHarnesses.length > 0
      ? backend.harness && codingHarnesses.includes(backend.harness)
        ? backend.harness
        : (codingHarnesses[0] as HarnessAgent)
      : undefined
  const harness = nativeHarness ?? managedHarness
  const agentKind = harness ? issueDefaultAgentKind(harness) : undefined
  const showModelEffort =
    agentKind && effortOptionsForModel(agentKind, backend.model, modelCatalog[agentKind]).length > 0

  /** The `harness` a given account persists for this role: the superagent pins its
   *  native harness, a coding managed account pins the CLI its credential drives,
   *  and everything else leaves it unset (undefined, not absent — the key must be
   *  written so switching back to a native account CLEARS a stale harness). */
  const harnessFor = (id: string, chosen?: HarnessAgent): HarnessAgent | undefined => {
    if (id.startsWith('native:')) {
      const h = id.slice('native:'.length) as HarnessAgent
      return role === 'superagent' ? h : undefined
    }
    if (role !== 'coding') return undefined
    const allowed = managedCodingHarnesses(id)
    if (allowed.length === 0) return undefined
    return chosen && allowed.includes(chosen) ? chosen : (allowed[0] as HarnessAgent)
  }
  const updateBackend = (patch: Partial<RoleBackend>) =>
    onChange({ ...backend, ...patch, harness: harnessFor(accountId, harness) })
  // The billing/execution explainer belongs to the Account choice, so it renders
  // as that row's description instead of a detached paragraph (POD-127 F3).
  const accountNote: React.ReactNode =
    accountId === 'native:claude-code' ? (
      <>
        Runs Claude Code&apos;s programmatic mode (<code className="text-[10px]">claude -p</code>)
        on this account — <span className="text-warning">usage counts against its limits</span>.
        API users are billed by token; subscribers consume plan usage.
      </>
    ) : accountId === 'native:codex' ? (
      <>
        Uses your local ChatGPT login (<code className="text-[10px]">codex login</code> on the
        server) — no API key; it uses your plan&apos;s included Codex capacity while limits allow.
      </>
    ) : isNative ? (
      <>
        Runs a real {harness} agent with its own tool belt, using its local login on this server.
      </>
    ) : codingHarnesses.length > 0 ? (
      <>
        Podium runs {managedHarness ? harnessAgentLabel(managedHarness) : 'a'} harness and injects
        the credential you connected under Accounts into its environment — so this session runs on
        that account from any connected machine.
      </>
    ) : (
      <>
        Billed per token against the key you set under Settings → API keys. This role calls the
        provider API directly.
      </>
    )
  return (
    <>
      <Row label="Account" description={accountNote}>
        <Select
          value={accountId}
          onValueChange={(value) => {
            const nextAccountId = value ?? ''
            onChange({
              accountId: nextAccountId,
              model: 'auto',
              effort: 'auto',
              harness: harnessFor(nextAccountId),
            })
          }}
        >
          <SelectTrigger className="w-full flex-1">
            <SelectValue>{selectedLabel}</SelectValue>
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
      {codingHarnesses.length > 0 && (
        <Row label="Harness">
          <Select
            value={managedHarness ?? ''}
            onValueChange={(value) =>
              onChange({
                ...backend,
                accountId,
                harness: harnessFor(accountId, (value ?? '') as HarnessAgent),
              })
            }
          >
            <SelectTrigger className="w-full flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {codingHarnesses.map((h) => (
                <SelectItem key={h} value={h}>
                  {harnessAgentLabel(h)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      <Row label="Model">
        {agentKind ? (
          <ModelPicker
            variant="field"
            agentKind={agentKind}
            value={backend.model}
            onChange={(model) => updateBackend({ model, effort: 'auto' })}
          />
        ) : (
          <Input
            type="text"
            placeholder="auto"
            value={backend.model === 'auto' ? '' : backend.model}
            onChange={(e) => updateBackend({ model: e.target.value || 'auto' })}
          />
        )}
      </Row>
      {showModelEffort && (
        <Row label="Effort">
          <EffortPicker
            variant="field"
            agentKind={agentKind}
            model={backend.model}
            value={backend.effort}
            onChange={(effort) => updateBackend({ effort })}
          />
        </Row>
      )}
    </>
  )
}
