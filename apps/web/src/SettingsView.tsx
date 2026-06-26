import {
  type AgentChoice,
  type ApiProvider,
  DEFAULT_SETTINGS,
  type HarnessAgent,
  type LlmBackend,
  type PodiumSettings,
} from '@podium/core'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
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
import { MachinesPanel } from './MachinesPanel'
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
  | 'workflow'
  | 'integrations'
  | 'machines'

type TelegramSetupState =
  | { status: 'idle' }
  | { status: 'starting' }
  | {
      status: 'polling'
      setupId: string
      code: string
      botUsername: string
      telegramUrl: string
      expiresAt: string
      error?: string
    }
  | { status: 'connected'; chatId: string; chatType: string; chatLabel?: string }
  | { status: 'expired' }
  | { status: 'failed'; message: string }

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'sessions', label: 'New sessions' },
  { key: 'superagent', label: 'Superagent' },
  { key: 'workllm', label: 'Background LLM' },
  { key: 'keys', label: 'API keys' },
  { key: 'hibernation', label: 'Hibernation' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'machines', label: 'Machines' },
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
  const [telegramSetup, setTelegramSetup] = useState<TelegramSetupState>({ status: 'idle' })
  const [telegramSetupNow, setTelegramSetupNow] = useState(() => Date.now())
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

  useEffect(() => {
    if (telegramSetup.status !== 'polling') return
    setTelegramSetupNow(Date.now())
    const id = window.setInterval(() => setTelegramSetupNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [telegramSetup.status])

  const activeTelegramSetup = telegramSetup.status === 'polling' ? telegramSetup : null

  useEffect(() => {
    if (!activeTelegramSetup) return
    let cancelled = false
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      if (Date.now() > Date.parse(activeTelegramSetup.expiresAt)) {
        setTelegramSetup({ status: 'expired' })
        return
      }
      inFlight = true
      try {
        const result = await trpc.settings.telegramSetupPoll.mutate({
          setupId: activeTelegramSetup.setupId,
        })
        if (cancelled) return
        if (result.status === 'connected') {
          setSettings(result.settings)
          setSavedAt(Date.now())
          setTelegramSetup({
            status: 'connected',
            chatId: result.chatId,
            chatType: result.chatType,
            ...(result.chatLabel ? { chatLabel: result.chatLabel } : {}),
          })
        } else if (result.status === 'expired') {
          setTelegramSetup({ status: 'expired' })
        } else {
          setTelegramSetup((current) =>
            current.status === 'polling' && current.setupId === activeTelegramSetup.setupId
              ? { ...current, error: undefined }
              : current,
          )
        }
      } catch (e) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : String(e)
          setTelegramSetup((current) =>
            current.status === 'polling' && current.setupId === activeTelegramSetup.setupId
              ? { ...current, error: message }
              : current,
          )
        }
      } finally {
        inFlight = false
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [activeTelegramSetup?.setupId, activeTelegramSetup?.expiresAt, trpc])

  const startTelegramSetup = async () => {
    if (!settings) return
    const token = settings.notifications.telegramBotToken.trim()
    if (!token) {
      setTelegramSetup({ status: 'failed', message: 'Paste a Telegram bot token first.' })
      return
    }

    setError(null)
    setTelegramSetup({ status: 'starting' })
    try {
      const saved = await trpc.settings.set.mutate(settings)
      setSettings(saved)
      const setup = await trpc.settings.telegramSetupStart.mutate()
      setTelegramSetup({ status: 'polling', ...setup })
      setTelegramSetupNow(Date.now())
    } catch (e) {
      setTelegramSetup({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

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
              <>
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
                    placeholder="filled by setup, or @channel"
                    value={settings.notifications.telegramChatId}
                    onChange={(e) => {
                      setTelegramSetup({ status: 'idle' })
                      patch({
                        notifications: {
                          ...settings.notifications,
                          telegramChatId: e.target.value,
                        },
                      })
                    }}
                  />
                </Row>
                <Row label="Telegram setup">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={telegramSetup.status === 'starting' || telegramSetup.status === 'polling'}
                      onClick={() => void startTelegramSetup()}
                    >
                      {telegramSetup.status === 'starting' ? (
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                      ) : (
                        <ExternalLink data-icon="inline-start" />
                      )}
                      {settings.notifications.telegramChatId.trim() ? 'Reconnect Telegram' : 'Connect Telegram'}
                    </Button>
                    <TelegramSetupStatus setup={telegramSetup} now={telegramSetupNow} />
                  </div>
                </Row>
                <div className="mt-2 max-w-[68ch] border-border border-l pl-3 text-[12px] text-muted-foreground">
                  <div className="mb-1 font-medium text-foreground">Telegram setup</div>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>
                      In Telegram, message <code className="text-[11px]">@BotFather</code> and use <code className="text-[11px]">/newbot</code> to create a bot. Paste its bot token here.
                    </li>
                    <li>
                      Click <span className="font-medium text-foreground">Connect Telegram</span>. Podium shows a Telegram link with a setup code and polls for 5 minutes.
                    </li>
                    <li>
                      Send the prefilled start message. When Podium sees the code, it fills the chat ID and sends a confirmation.
                    </li>
                  </ol>
                  <p className="mt-1.5">
                    Public channels can still use <code className="text-[11px]">@channelusername</code>. These settings are global for this Podium server.
                  </p>
                </div>
              </Section>
            )}

            {tab === 'workflow' && settings && (
              <Section
                title="Git workflow"
                hint="Defaults for issue worktrees and the quick-action buttons."
              >
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
                      <SelectValue />
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
                <Row label="Issue AI assistant enabled">
                  <Switch
                    checked={settings.issues.assistantEnabled}
                    onCheckedChange={(checked) =>
                      patch({ issues: { ...settings.issues, assistantEnabled: checked } })
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

            {tab === 'machines' && <MachinesPanel />}
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
function formatTelegramSetupRemaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes + ':' + rest.toString().padStart(2, '0')
}

function TelegramSetupStatus({
  setup,
  now,
}: {
  setup: TelegramSetupState
  now: number
}): JSX.Element | null {
  if (setup.status === 'idle' || setup.status === 'starting') return null
  if (setup.status === 'failed') {
    return <p className="text-destructive text-xs">{setup.message}</p>
  }
  if (setup.status === 'expired') {
    return <p className="text-muted-foreground text-xs">Setup expired. Start again.</p>
  }
  if (setup.status === 'connected') {
    const target = setup.chatLabel ?? setup.chatId
    return (
      <p className="inline-flex items-center gap-1 text-success text-xs">
        <CheckCircle2 className="size-3.5" /> Connected to {target}.
      </p>
    )
  }

  return (
    <div className="max-w-[68ch] space-y-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-foreground">
        <span>Waiting for Telegram</span>
        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px]">{setup.code}</code>
        <span className="text-muted-foreground">
          {formatTelegramSetupRemaining(setup.expiresAt, now)} left
        </span>
      </div>
      <a
        className="inline-flex items-center gap-1 text-primary hover:underline"
        href={setup.telegramUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open Telegram with this code
        <ExternalLink className="size-3" />
      </a>
      {setup.error && <p className="text-destructive">{setup.error}</p>}
    </div>
  )
}

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

export function backendWithRunKind(backend: LlmBackend, kind: LlmBackend['kind']): LlmBackend {
  return {
    ...backend,
    kind,
    harnessAgent:
      kind === 'harness' && backend.harnessAgent === 'codex'
        ? 'claude-code'
        : backend.harnessAgent,
  }
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

function harnessAgentLabel(agent: HarnessAgent): string {
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
          onValueChange={(value) =>
            onChange(backendWithRunKind(backend, value as LlmBackend['kind']))
          }
        >
          <SelectTrigger className="w-full flex-1">
            <span className="flex flex-1 text-left">
              {backend.kind === 'api'
                ? 'Provider backend (API key or local login)'
                : 'Agent CLI harness'}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api">Provider backend (API key or local login)</SelectItem>
            <SelectItem value="harness">Agent CLI harness</SelectItem>
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
              server) — no API key; it uses your plan's included Codex capacity while limits
              allow. Gets the full orchestrator tool belt and, unlike the old Codex harness, never
              shells out to a CLI.
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
                <span className="flex flex-1 text-left">
                  {harnessAgentLabel(backend.harnessAgent)}
                </span>
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
          {backend.harnessAgent === 'claude-code' ? (
            <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-warning">
              Heads up: Claude Code's programmatic mode (
              <code className="text-[11px]">claude -p</code>) uses your Claude Code account and
              counts against that account's usage/rate limits. API users are billed by token;
              subscribers consume plan usage. For the ChatGPT-subscription backend, pick Provider
              backend → Codex instead.
            </p>
          ) : (
            <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
              Podium runs a real {backend.harnessAgent} agent with its CLI tool belt,
              using your local login, and injects this feature's system prompt.
            </p>
          )}
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
