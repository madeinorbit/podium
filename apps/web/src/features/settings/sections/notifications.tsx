import { CUE_SOUNDS, play, SOUNDS_ENABLED_KEY } from '@podium/client-core/sound'
import type { PodiumSettings } from '@podium/runtime'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Row, Section } from './shared'

/**
 * The guided Telegram connect flow's state machine. Owned by SettingsView (not
 * this section) so an in-flight poll survives switching to another tab — on
 * `connected` it also updates the parent's settings copy.
 */
export type TelegramSetupState =
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

/** Web + push notification targets, including the guided Telegram setup. */
export function NotificationsSection({
  settings,
  patch,
  telegramSetup,
  telegramSetupNow,
  onStartTelegramSetup,
  onResetTelegramSetup,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
  telegramSetup: TelegramSetupState
  telegramSetupNow: number
  onStartTelegramSetup: () => void
  onResetTelegramSetup: () => void
}): JSX.Element {
  return (
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
      <SoundsRow />
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
            onResetTelegramSetup()
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
            onClick={onStartTelegramSetup}
          >
            {telegramSetup.status === 'starting' ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <ExternalLink data-icon="inline-start" />
            )}
            {settings.notifications.telegramChatId.trim()
              ? 'Reconnect Telegram'
              : 'Connect Telegram'}
          </Button>
          <TelegramSetupStatus setup={telegramSetup} now={telegramSetupNow} />
        </div>
      </Row>
      <div className="mt-2 max-w-[68ch] border-border border-l pl-3 text-[12px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">Telegram setup</div>
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            In Telegram, message <code className="text-[11px]">@BotFather</code> and use{' '}
            <code className="text-[11px]">/newbot</code> to create a bot. Paste its bot token here.
          </li>
          <li>
            Click <span className="font-medium text-foreground">Connect Telegram</span>. Podium
            shows a Telegram link with a setup code and polls for 5 minutes.
          </li>
          <li>
            Send the prefilled start message. When Podium sees the code, it fills the chat ID and
            sends a confirmation.
          </li>
        </ol>
        <p className="mt-1.5">
          Public channels can still use <code className="text-[11px]">@channelusername</code>. These
          settings are global for this Podium server.
        </p>
      </div>
    </Section>
  )
}

function formatTelegramSetupRemaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
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
        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px]">
          {setup.code}
        </code>
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

/** Sound cues on agent-state transitions [POD-78]. Device-local (UiState, not
 *  the server settings blob): it's about THIS machine's speakers. Flipping it
 *  on plays the "done" cue — a preview that doubles as the user gesture
 *  WKWebView needs to unlock audio. */
function SoundsRow(): JSX.Element {
  const uiState = useStoreSelector((s) => s.uiState)
  const [enabled, setEnabled] = useState(() => uiState.get(SOUNDS_ENABLED_KEY) !== 'false')
  return (
    <Row label="Notification sounds">
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => {
          uiState.set(SOUNDS_ENABLED_KEY, String(checked))
          setEnabled(checked)
          if (checked) play(CUE_SOUNDS.done)
        }}
      />
      <span className="text-muted-foreground text-xs">
        agent done, questions, approvals, errors — this device only
      </span>
    </Row>
  )
}

/** Browser notification permission needs a user gesture — this is the gesture. */
function NotificationPermissionButton(): JSX.Element | null {
  const [perm, setPerm] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  if (perm === 'unsupported')
    return <span className="text-muted-foreground text-xs">not supported here</span>
  if (perm === 'granted') return <span className="text-success text-xs">permission granted</span>
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
