import {
  type AgentChoice,
  type ApiProvider,
  DEFAULT_SETTINGS,
  type HarnessAgent,
  type LlmBackend,
  type PodiumSettings,
} from '@podium/core'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useStore } from './store'
import { type ThemeMode, type ThemePreset, useTheme } from './theme'

export type SettingsTab =
  | 'appearance'
  | 'sessions'
  | 'superagent'
  | 'workllm'
  | 'keys'
  | 'hibernation'
  | 'notifications'
  | 'integrations'

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'sessions', label: 'New sessions' },
  { key: 'superagent', label: 'Superagent' },
  { key: 'workllm', label: 'Background LLM' },
  { key: 'keys', label: 'API keys' },
  { key: 'hibernation', label: 'Hibernation' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'integrations', label: 'Integrations' },
]

/**
 * Settings — a full main-content surface (not a modal), split into sections via a
 * side nav. Loads the whole blob, edits a local copy, saves it whole — no
 * per-field mutations, so the form can never half-apply even though only one
 * section is on screen at a time.
 */
export function SettingsView(): JSX.Element {
  const { trpc, setView, settingsTab, setSettingsTab } = useStore()
  const [settings, setSettings] = useState<PodiumSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  // Honor a deep-link target (e.g. from global search) for the initial tab, then
  // clear it so a later plain "open settings" lands on the default.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = settingsTab
    return t && SETTINGS_TABS.some((s) => s.key === t) ? (t as SettingsTab) : 'sessions'
  })
  useEffect(() => {
    if (settingsTab) setSettingsTab(null)
  }, [settingsTab, setSettingsTab])

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      setSettings(await trpc.settings.set.mutate(settings))
      setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<PodiumSettings>) => setSettings((s) => (s ? { ...s, ...p } : s))

  return (
    <section
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Settings"
    >
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close settings"
          onClick={() => setView('home')}
        >
          ✕
        </Button>
      </div>
      {error && (
        <div className="border-border border-b px-4 py-2 text-destructive text-xs">
          {error}
        </div>
      )}
      {!settings ? (
        <div className="flex-1 overflow-y-auto px-4 py-1 pb-3 md:px-[22px] md:pb-4">
          <div className="p-3 text-muted-foreground/70 text-xs">Loading settings…</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            className="flex flex-row gap-1 overflow-x-auto border-border border-b p-2 md:w-[200px] md:flex-none md:flex-col md:gap-0.5 md:overflow-y-auto md:border-r md:border-b-0 md:p-3 md:px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Settings sections"
          >
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={cn(
                  'cursor-pointer whitespace-nowrap rounded-md px-2.5 py-2 text-left text-muted-foreground text-[13px] transition-colors hover:bg-accent hover:text-foreground',
                  t.key === tab && 'bg-accent text-foreground',
                )}
                aria-current={t.key === tab}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto px-4 py-1 pb-4 md:px-[22px]">
            {tab === 'appearance' && <AppearanceSection />}

            {tab === 'sessions' && (
              <Section
                title="New sessions"
                hint="Defaults applied when starting agents. “Agent decides” passes no flag — the CLI uses its own configuration."
              >
                <Row label="Default agent">
                  <Select
                    value={settings.sessionDefaults.agent}
                    onValueChange={(value) =>
                      patch({
                        sessionDefaults: {
                          ...settings.sessionDefaults,
                          agent: value as AgentChoice,
                        },
                      })
                    }
                  >
                    <SelectTrigger className="w-full flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Agent decides (Claude Code)</SelectItem>
                      <SelectItem value="claude-code">Claude Code</SelectItem>
                      <SelectItem value="codex">Codex</SelectItem>
                      <SelectItem value="grok">Grok</SelectItem>
                      <SelectItem value="opencode">OpenCode</SelectItem>
                      <SelectItem value="cursor">Cursor</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
                <Row label="Model for new sessions">
                  <ModelInput
                    value={settings.sessionDefaults.model}
                    onChange={(model) =>
                      patch({ sessionDefaults: { ...settings.sessionDefaults, model } })
                    }
                  />
                </Row>
                <Row label="Model for subagents">
                  <ModelInput
                    value={settings.sessionDefaults.subagentModel}
                    onChange={(subagentModel) =>
                      patch({ sessionDefaults: { ...settings.sessionDefaults, subagentModel } })
                    }
                  />
                </Row>
                <Row label="New session opens on">
                  <Select
                    value={settings.sessionDefaults.startScreen}
                    onValueChange={(value) =>
                      patch({
                        sessionDefaults: {
                          ...settings.sessionDefaults,
                          startScreen: value as 'native' | 'chat' | 'auto',
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
            )}

            {tab === 'superagent' && (
              <Section
                title="Superagent"
                hint="The orchestrator that starts, stops, and reasons across all your agents."
              >
                <BackendEditor
                  backend={settings.superagent}
                  onChange={(superagent) => patch({ superagent })}
                />
              </Section>
            )}

            {tab === 'workllm' && (
              <Section
                title="Background work LLM"
                hint="Summarizing session state, naming conversations, extracting work status. Cheap + fast is the right call here."
              >
                <BackendEditor
                  backend={settings.workLlm}
                  onChange={(workLlm) => patch({ workLlm })}
                />
              </Section>
            )}

            {tab === 'keys' && (
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
                      onChange={(e) =>
                        patch({ apiKeys: { ...settings.apiKeys, [k]: e.target.value } })
                      }
                    />
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'hibernation' && (
              <Section
                title="Auto-hibernation"
                hint="When a machine's memory crosses the threshold, idle sessions hibernate. One click resumes them."
              >
                <Row label="Enabled">
                  <Switch
                    checked={settings.hibernation.enabled}
                    onCheckedChange={(checked) =>
                      patch({ hibernation: { ...settings.hibernation, enabled: checked } })
                    }
                  />
                </Row>
                <Row label="Memory threshold (%)">
                  <Input
                    className="w-[90px] flex-none"
                    type="number"
                    min={50}
                    max={95}
                    value={settings.hibernation.memoryPct}
                    onChange={(e) =>
                      patch({
                        hibernation: {
                          ...settings.hibernation,
                          memoryPct: clampInt(e.target.value, 50, 95, 80),
                        },
                      })
                    }
                  />
                </Row>
                <Row label="Idle after (minutes)">
                  <Input
                    className="w-[90px] flex-none"
                    type="number"
                    min={1}
                    max={1440}
                    value={settings.hibernation.idleMinutes}
                    onChange={(e) =>
                      patch({
                        hibernation: {
                          ...settings.hibernation,
                          idleMinutes: clampInt(e.target.value, 1, 1440, 30),
                        },
                      })
                    }
                  />
                </Row>
              </Section>
            )}

            {tab === 'notifications' && (
              <Section
                title="Notifications"
                hint="Web notifications fire when this page is open in the background. External push targets use the same smart routing: they stay quiet while a Podium window is visible."
              >
                <Row label="Web notifications">
                  <Switch
                    checked={settings.notifications.web}
                    onCheckedChange={(checked) =>
                      patch({
                        notifications: { ...settings.notifications, web: checked },
                      })
                    }
                  />
                  <NotificationPermissionButton />
                </Row>
                <Row label="ntfy.sh topic">
                  <Input
                    type="text"
                    placeholder="e.g. podium-a8f3k2 (empty = off)"
                    value={settings.notifications.ntfyTopic}
                    onChange={(e) =>
                      patch({
                        notifications: { ...settings.notifications, ntfyTopic: e.target.value },
                      })
                    }
                  />
                </Row>
                <Row label="Telegram bot token">
                  <Input
                    type="password"
                    placeholder="empty = off"
                    value={settings.notifications.telegramBotToken}
                    onChange={(e) =>
                      patch({
                        notifications: {
                          ...settings.notifications,
                          telegramBotToken: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
                <Row label="Telegram chat ID">
                  <Input
                    type="text"
                    placeholder="e.g. -1001234567890 or @channel"
                    value={settings.notifications.telegramChatId}
                    onChange={(e) =>
                      patch({
                        notifications: {
                          ...settings.notifications,
                          telegramChatId: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
              </Section>
            )}

            {tab === 'integrations' && (
              <Section
                title="Integrations"
                hint="Linear lets the superagent pick up, add, and move tickets."
              >
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
            )}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2.5 border-border border-t px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto text-muted-foreground/70 hover:text-foreground"
          onClick={() => setSettings(DEFAULT_SETTINGS)}
        >
          Reset to defaults
        </Button>
        {savedAt > 0 && Date.now() - savedAt < 4000 && (
          <span className="text-success text-xs">Saved.</span>
        )}
        <Button
          type="button"
          size="sm"
          disabled={!settings || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  )
}

/** Browser notification permission needs a user gesture — this is the gesture. */
function NotificationPermissionButton(): JSX.Element | null {
  const [perm, setPerm] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  if (perm === 'unsupported')
    return <span className="text-muted-foreground text-xs">not supported here</span>
  if (perm === 'granted')
    return <span className="text-success text-xs">permission granted</span>
  if (perm === 'denied')
    return <span className="text-muted-foreground text-xs">blocked in browser settings</span>
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void Notification.requestPermission().then(setPerm)
      }}
    >
      Grant permission
    </Button>
  )
}

function providerLabel(p: ApiProvider): string {
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

function Section({
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

/** Theme + light/dark switcher. Theme state is UI-local (not part of the settings
 *  blob), so it applies instantly via useTheme and persists on its own. */
function AppearanceSection(): JSX.Element {
  const { preset, mode, setPreset, setMode } = useTheme()
  const presets: { value: ThemePreset; label: string }[] = [
    { value: 'podium', label: 'Podium' },
    { value: 'shadcn', label: 'shadcn' },
  ]
  const modes: { value: ThemeMode; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ]
  return (
    <Section
      title="Appearance"
      hint="Theme and light/dark mode. Applies instantly and is remembered on this device."
    >
      <Row label="Theme">
        <div className="flex gap-1">
          {presets.map((p) => (
            <Button
              key={p.value}
              type="button"
              size="sm"
              variant={preset === p.value ? 'default' : 'outline'}
              aria-pressed={preset === p.value}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </Row>
      <Row label="Mode">
        <div className="flex gap-1">
          {modes.map((m) => (
            <Button
              key={m.value}
              type="button"
              size="sm"
              variant={mode === m.value ? 'default' : 'outline'}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Row>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  // Every Row holds exactly one control, but the type system can't prove that to
  // the a11y lint — a div keeps it honest; the visible text still sits beside it.
  return (
    <div className="flex items-center gap-2.5 py-1 text-[13px]">
      <span className="flex-none basis-[140px] text-foreground md:basis-[180px]">{label}</span>
      {children}
    </div>
  )
}

function ModelInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <Input
      type="text"
      // 'auto' is the stored sentinel; the empty input *means* auto.
      value={value === 'auto' ? '' : value}
      placeholder="auto — agent decides"
      onChange={(e) => onChange(e.target.value.trim() === '' ? 'auto' : e.target.value)}
    />
  )
}

/**
 * Shared editor for the superagent / work-LLM execution backends, including the
 * billing explainer the spec demands when picking a harness.
 */
function BackendEditor({
  backend,
  onChange,
}: {
  backend: LlmBackend
  onChange: (b: LlmBackend) => void
}): JSX.Element {
  return (
    <>
      <Row label="Run on">
        <Select
          value={backend.kind}
          onValueChange={(value) => onChange({ ...backend, kind: value as LlmBackend['kind'] })}
        >
          <SelectTrigger className="w-full flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api">API provider (key required)</SelectItem>
            <SelectItem value="harness">Coding-agent harness</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {backend.kind === 'api' ? (
        <>
          <Row label="Provider">
            <Select
              value={backend.provider}
              onValueChange={(value) => {
                const provider = value as ApiProvider
                // Codex models look nothing like the OpenRouter/Anthropic ones, so
                // prefill a sane default when switching into (or out of) it.
                const model =
                  provider === 'codex' && backend.provider !== 'codex'
                    ? 'gpt-5.5'
                    : provider !== 'codex' && backend.provider === 'codex'
                      ? 'anthropic/claude-sonnet-4.5'
                      : backend.model
                onChange({ ...backend, provider, model })
              }}
            >
              <SelectTrigger className="w-full flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openrouter">OpenRouter (default — any model)</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="codex">Codex — ChatGPT subscription (no key)</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Model">
            <Input
              type="text"
              value={backend.model}
              onChange={(e) => onChange({ ...backend, model: e.target.value })}
            />
          </Row>
          {backend.provider === 'codex' ? (
            <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
              Uses your local ChatGPT login (<code className="text-[11px]">codex login</code> on the
              server) — no API key, effectively free within your plan's limits. Gets the full
              orchestrator tool belt and, unlike the old Codex harness, never shells out to a CLI.
            </p>
          ) : (
            <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
              Billed per token against your API key. Worker agents the superagent starts still run
              on your normal subscriptions — only the orchestration itself is metered.
            </p>
          )}
        </>
      ) : (
        <>
          <Row label="Harness">
            <Select
              value={backend.harnessAgent}
              onValueChange={(value) =>
                onChange({ ...backend, harnessAgent: value as HarnessAgent })
              }
            >
              <SelectTrigger className="w-full flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="grok">Grok</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="cursor">Cursor</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Model">
            <ModelInput
              value={backend.harnessModel}
              onChange={(harnessModel) => onChange({ ...backend, harnessModel })}
            />
          </Row>
          <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-warning">
            Heads up: Claude Code's programmatic mode (<code className="text-[11px]">claude -p</code>)
            bills pay-per-use API rates even when you have a subscription. Grok runs through{' '}
            <code className="text-[11px]">grok -p</code> with your local Grok login. For free Codex
            orchestration, pick API provider → Codex instead.
          </p>
        </>
      )}
    </>
  )
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
