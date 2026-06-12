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
import { useStore } from './store'

/**
 * Settings modal. Loads the whole blob, edits a local copy, saves it whole —
 * no per-field mutations, so the form can never half-apply.
 */
export function SettingsView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc } = useStore()
  const [settings, setSettings] = useState<PodiumSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)

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
    <div className="modal-backdrop" role="presentation">
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="settings-error">{error}</div>}
        {!settings ? (
          <div className="settings-body">
            <div className="empty">Loading settings…</div>
          </div>
        ) : (
          <div className="settings-body">
            <Section
              title="New sessions"
              hint="Defaults applied when starting agents. “Agent decides” passes no flag — the CLI uses its own configuration."
            >
              <Row label="Default agent">
                <select
                  value={settings.sessionDefaults.agent}
                  onChange={(e) =>
                    patch({
                      sessionDefaults: {
                        ...settings.sessionDefaults,
                        agent: e.target.value as AgentChoice,
                      },
                    })
                  }
                >
                  <option value="auto">Agent decides (Claude Code)</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
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
            </Section>

            <Section
              title="Superagent"
              hint="The orchestrator that starts, stops, and reasons across all your agents."
            >
              <BackendEditor
                backend={settings.superagent}
                onChange={(superagent) => patch({ superagent })}
              />
            </Section>

            <Section
              title="Background work LLM"
              hint="Summarizing session state, naming conversations, extracting work status. Cheap + fast is the right call here."
            >
              <BackendEditor
                backend={settings.workLlm}
                onChange={(workLlm) => patch({ workLlm })}
              />
            </Section>

            <Section
              title="API keys"
              hint="Stored in Podium's own database on your server — the same trust domain as the shells your agents already run in."
            >
              {(['openrouter', 'anthropic', 'openai'] as const).map((k) => (
                <Row key={k} label={providerLabel(k)}>
                  <input
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

            <Section
              title="Auto-hibernation"
              hint="When a machine's memory crosses the threshold, idle sessions hibernate. One click resumes them."
            >
              <Row label="Enabled">
                <input
                  type="checkbox"
                  checked={settings.hibernation.enabled}
                  onChange={(e) =>
                    patch({ hibernation: { ...settings.hibernation, enabled: e.target.checked } })
                  }
                />
              </Row>
              <Row label="Memory threshold (%)">
                <input
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
                <input
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

            <Section
              title="Notifications"
              hint="Web notifications fire when this page is open in the background. The ntfy topic adds real mobile push: install the free ntfy app, subscribe to your topic."
            >
              <Row label="Web notifications">
                <input
                  type="checkbox"
                  checked={settings.notifications.web}
                  onChange={(e) =>
                    patch({
                      notifications: { ...settings.notifications, web: e.target.checked },
                    })
                  }
                />
                <NotificationPermissionButton />
              </Row>
              <Row label="ntfy.sh topic">
                <input
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
            </Section>

            <Section
              title="Integrations"
              hint="Linear lets the superagent pick up, add, and move tickets."
            >
              <Row label="Linear API key">
                <input
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
          </div>
        )}
        <div className="settings-footer">
          <button
            type="button"
            className="settings-reset"
            onClick={() => setSettings(DEFAULT_SETTINGS)}
          >
            Reset to defaults
          </button>
          {savedAt > 0 && Date.now() - savedAt < 4000 && (
            <span className="settings-saved">Saved.</span>
          )}
          <button
            type="button"
            className="settings-save"
            disabled={!settings || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Browser notification permission needs a user gesture — this is the gesture. */
function NotificationPermissionButton(): JSX.Element | null {
  const [perm, setPerm] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  if (perm === 'unsupported') return <span className="settings-note">not supported here</span>
  if (perm === 'granted') return <span className="settings-saved">permission granted</span>
  if (perm === 'denied') return <span className="settings-note">blocked in browser settings</span>
  return (
    <button
      type="button"
      className="settings-permission"
      onClick={() => {
        void Notification.requestPermission().then(setPerm)
      }}
    >
      Grant permission
    </button>
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
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="settings-hint">{hint}</p>}
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  // Every Row holds exactly one control, but the type system can't prove that to
  // the a11y lint — a div keeps it honest; the visible text still sits beside it.
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
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
    <input
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
        <select
          value={backend.kind}
          onChange={(e) => onChange({ ...backend, kind: e.target.value as LlmBackend['kind'] })}
        >
          <option value="api">API provider (key required)</option>
          <option value="harness">Coding-agent harness</option>
        </select>
      </Row>
      {backend.kind === 'api' ? (
        <>
          <Row label="Provider">
            <select
              value={backend.provider}
              onChange={(e) => onChange({ ...backend, provider: e.target.value as ApiProvider })}
            >
              <option value="openrouter">OpenRouter (default — any model)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </Row>
          <Row label="Model">
            <input
              type="text"
              value={backend.model}
              onChange={(e) => onChange({ ...backend, model: e.target.value })}
            />
          </Row>
          <p className="settings-note">
            Billed per token against your API key. Worker agents the superagent starts still run on
            your normal subscriptions — only the orchestration itself is metered.
          </p>
        </>
      ) : (
        <>
          <Row label="Harness">
            <select
              value={backend.harnessAgent}
              onChange={(e) =>
                onChange({ ...backend, harnessAgent: e.target.value as HarnessAgent })
              }
            >
              <option value="codex">Codex CLI</option>
              <option value="claude-code">Claude Code</option>
            </select>
          </Row>
          <Row label="Model">
            <ModelInput
              value={backend.harnessModel}
              onChange={(harnessModel) => onChange({ ...backend, harnessModel })}
            />
          </Row>
          {backend.harnessAgent === 'codex' ? (
            <p className="settings-note">
              Codex's terms allow programmatic use of your ChatGPT subscription — this backend is
              effectively free if you stay within your plan's limits.
            </p>
          ) : (
            <p className="settings-note settings-warn">
              Heads up: Claude Code's programmatic mode (<code>claude -p</code>) bills pay-per-use
              API rates even when you have a subscription. Interactive sessions stay on the
              subscription; this backend does not.
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
