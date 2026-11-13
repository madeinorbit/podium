import { CUE_SOUNDS, play, SOUNDS_ENABLED_KEY } from '@podium/client-core/sound'
import type { ServerSecretKey } from '@podium/model/browser'
import type { PodiumSettings } from '@podium/runtime'
import { CheckCircle2, ExternalLink, Info, Send } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { createContext, type JSX, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCountdown } from '@/lib/clock-hooks'
import { useSettingsDraft } from '../readers'
import type { SecretSurfaceState } from '../secret-presence'
import { useSettingsFrame } from '../settings-frame'
import { CommitInput, Row, SecretRow, Section, SwitchRow } from './shared'

/** The existing SettingsView ceremony owns polling and the synced preference
 * update. A context above SettingsFrame keeps an open takeover live. */
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

export const TelegramSetupContext = createContext<TelegramSetupState>({ status: 'idle' })
export type TelegramBotPresence = 'loading' | 'unavailable' | boolean
const TELEGRAM_TOKEN: ServerSecretKey = 'notifications.telegramBotToken'

export const NotificationsSection = observer(function NotificationsSection({
  settings,
  patch,
  telegramSetup,
  onStartTelegramSetup,
  onDisconnectTelegram,
  telegramBotPresent,
  onRefreshTelegramBot,
  secrets,
  canManageSecrets,
  secretBusy,
  secretError,
  onSetSecret,
  onClearSecret,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void | Promise<void>
  telegramSetup: TelegramSetupState
  onStartTelegramSetup: () => void
  onDisconnectTelegram: () => Promise<void>
  telegramBotPresent: TelegramBotPresence
  onRefreshTelegramBot: () => void
  secrets: SecretSurfaceState
  canManageSecrets: boolean
  secretBusy: boolean
  secretError: string | null
  onSetSecret: (key: ServerSecretKey, value: string) => Promise<void>
  onClearSecret: (key: ServerSecretKey) => Promise<void>
}): JSX.Element {
  const frame = useSettingsFrame()
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const bot =
    secrets.status === 'available'
      ? secrets.rows.find((row) => row.key === TELEGRAM_TOKEN)
      : undefined
  const chat = settings.notifications.telegramChatId.trim()
  const description = chat
    ? `Connected to ${chat}.`
    : telegramBotPresent === true
      ? 'Get a message from the workspace bot.'
      : telegramBotPresent === false
        ? 'Needs the workspace’s Telegram bot first.'
        : telegramBotPresent === 'loading'
          ? 'Checking the workspace’s Telegram bot…'
          : 'Could not check the workspace’s Telegram bot.'
  const startConnect = () => {
    onStartTelegramSetup()
    frame.openTakeover({
      title: 'Connect Telegram',
      content: <TelegramConnectFlow onStart={onStartTelegramSetup} />,
    })
  }
  const disconnect = async () => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await onDisconnectTelegram()
      toast('Telegram disconnected')
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : String(error))
    } finally {
      setDisconnecting(false)
    }
  }
  return (
    <>
      <Section title="On this computer">
        <BrowserNotificationsRow settings={settings} patch={patch} />
        <SoundsRow />
      </Section>
      <Section
        title="On your phone"
        hint="For when you are away from the computer. Use one, or both."
      >
        <Row
          label="Telegram"
          description={description}
          pending={disconnecting}
          error={disconnectError}
        >
          {chat ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          ) : telegramBotPresent === true ? (
            <Button type="button" size="sm" variant="outline" onClick={startConnect}>
              <Send data-icon="inline-start" />
              Connect
            </Button>
          ) : telegramBotPresent === false ? (
            canManageSecrets ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  frame.openTakeover({
                    title: 'Set up the Telegram bot',
                    description:
                      'Once, for the whole workspace. Then everyone can connect their own chat.',
                    content: (
                      <TelegramBotFlow onSave={(value) => onSetSecret(TELEGRAM_TOKEN, value)} />
                    ),
                  })
                }
              >
                Set up bot
              </Button>
            ) : (
              <span className="settings-micro text-muted-foreground">Ask an admin</span>
            )
          ) : telegramBotPresent === 'unavailable' ? (
            <Button type="button" size="sm" variant="outline" onClick={onRefreshTelegramBot}>
              Try again
            </Button>
          ) : (
            <span className="settings-micro text-muted-foreground">Checking…</span>
          )}
        </Row>
        <Row
          setting="notifications.ntfyTopic"
          label="ntfy topic"
          description="Push through the free ntfy app. Pick a long topic name nobody can guess."
        >
          <CommitInput
            aria-label="ntfy topic"
            className="font-mono"
            placeholder="podium-a8f3k2"
            value={settings.notifications.ntfyTopic}
            onChange={(event) =>
              void patch({
                notifications: { ...settings.notifications, ntfyTopic: event.target.value },
              })
            }
          />
        </Row>
      </Section>
      {canManageSecrets && bot?.present && (
        <Section
          title="Telegram bot"
          hint="One bot for the whole workspace. Each person connects their own chat to it."
        >
          <SecretRow
            label="Bot token"
            setting={TELEGRAM_TOKEN}
            description="Everyone"
            present={bot.present}
            fingerprint={bot.fingerprint}
            pending={secretBusy}
            error={secretError}
            onSave={(value) => onSetSecret(TELEGRAM_TOKEN, value)}
            onRemove={() => onClearSecret(TELEGRAM_TOKEN)}
          />
        </Section>
      )}
      {telegramSetup.status === 'failed' && !chat && (
        <p className="settings-prose mt-3 text-destructive" role="alert">
          {telegramSetup.message}
        </p>
      )}
    </>
  )
})

function TelegramConnectFlow({ onStart }: { onStart: () => void }): JSX.Element {
  const setup = useContext(TelegramSetupContext)
  const { closeTakeover } = useSettingsFrame()
  return (
    <>
      <ol className="space-y-6" aria-label="Connect Telegram steps">
        <li className="flex gap-3">
          <StepNumber number={1} />
          <div className="min-w-0 flex-1">
            <h4 className="settings-label">Open the bot in Telegram</h4>
            <p className="settings-prose mt-1">
              The message is filled in for you. It carries a one-time code.
            </p>
            {setup.status === 'polling' && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  className={buttonVariants({ size: 'sm' })}
                  href={setup.telegramUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Send className="size-3.5" aria-hidden="true" />
                  Open @{setup.botUsername}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
                <span className="settings-micro font-mono">
                  code {setup.code} · <TelegramSetupRemaining expiresAt={setup.expiresAt} />
                </span>
              </div>
            )}
          </div>
        </li>
        <li className="flex gap-3">
          <StepNumber number={2} />
          <div className="min-w-0 flex-1">
            <h4 className="settings-label">Press Send</h4>
            <p className="settings-prose mt-1">
              Podium connects the chat that sends the code, so nobody can type in someone else’s.
            </p>
          </div>
        </li>
      </ol>
      <div className="settings-prose mt-6" role="status" aria-live="polite">
        {setup.status === 'idle' || setup.status === 'starting' ? (
          'Preparing your Telegram link…'
        ) : setup.status === 'polling' ? (
          'Waiting for your message in Telegram…'
        ) : setup.status === 'expired' ? (
          'Setup expired. Start again.'
        ) : setup.status === 'failed' ? (
          setup.message
        ) : (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <CheckCircle2 className="size-3.5 text-success" />
            Connected to {setup.chatLabel ?? setup.chatId}.
          </span>
        )}
      </div>
      {setup.status === 'polling' && setup.error && (
        <p className="settings-prose mt-2 text-destructive" role="alert">
          {setup.error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={closeTakeover}>
          {setup.status === 'connected' ? 'Done' : 'Cancel'}
        </Button>
        {(setup.status === 'expired' || setup.status === 'failed') && (
          <Button type="button" onClick={onStart}>
            Try again
          </Button>
        )}
      </div>
    </>
  )
}

function TelegramBotFlow({ onSave }: { onSave: (value: string) => Promise<void> }): JSX.Element {
  const { closeTakeover } = useSettingsFrame()
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!token.trim() || pending) return
        const value = token.trim()
        setToken('')
        setError(null)
        setPending(true)
        void onSave(value)
          .then(() => {
            toast('Bot saved')
            closeTakeover()
          })
          .catch((error: unknown) =>
            setError(error instanceof Error ? error.message : String(error)),
          )
          .finally(() => setPending(false))
      }}
    >
      <ol className="space-y-6" aria-label="Telegram bot setup steps">
        <li className="flex gap-3">
          <StepNumber number={1} />
          <div>
            <h4 className="settings-label">Create a bot</h4>
            <p className="settings-prose mt-1">
              In Telegram, message{' '}
              <a
                className="text-primary hover:underline"
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
              >
                @BotFather
              </a>
              , send <code>/newbot</code>, and follow the two questions.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <StepNumber number={2} />
          <div className="min-w-0 flex-1">
            <label htmlFor="telegram-bot-token" className="settings-label">
              Paste its token
            </label>
            <Input
              id="telegram-bot-token"
              className="mt-3 font-mono"
              type="password"
              autoComplete="off"
              placeholder="123456:ABC-DEF…"
              value={token}
              disabled={pending}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        </li>
      </ol>
      {error && (
        <p className="settings-prose mt-3 text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={closeTakeover}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !token.trim()}>
          {pending ? 'Saving…' : 'Save bot'}
        </Button>
      </div>
    </form>
  )
}

function StepNumber({ number }: { number: number }): JSX.Element {
  return (
    <span
      className="settings-micro flex size-7 shrink-0 items-center justify-center rounded-full border border-hairline-soft font-mono"
      aria-hidden="true"
    >
      {number}
    </span>
  )
}
function TelegramSetupRemaining({ expiresAt }: { expiresAt: string }): JSX.Element {
  const remaining = useCountdown(Date.parse(expiresAt))
  const seconds = Math.ceil(remaining / 1000)
  return (
    <>
      {Math.floor(seconds / 60)}:{(seconds % 60).toString().padStart(2, '0')} left
    </>
  )
}

const parseSounds = (raw: string | null): boolean => raw !== 'false'
const serializeSounds = (value: boolean): string => String(value)
function SoundsRow(): JSX.Element {
  const [enabled, setEnabled] = useSettingsDraft(SOUNDS_ENABLED_KEY, parseSounds, serializeSounds)
  return (
    <SwitchRow
      label="Sounds"
      device
      description="A short cue when an agent finishes, asks, or hits an error."
      value={enabled}
      onChange={(checked) => {
        setEnabled(checked)
        if (checked) play(CUE_SOUNDS.done)
      }}
    />
  )
}

function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const refresh = () =>
      setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const grant = async () => {
    setPending(true)
    setError(null)
    try {
      setPermission(await Notification.requestPermission())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return { permission, error, pending, grant }
}
const BrowserNotificationsRow = observer(function BrowserNotificationsRow({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void | Promise<void>
}): JSX.Element {
  const { permission, grant, pending, error } = useNotificationPermission()
  return (
    <>
      <SwitchRow
        setting="notifications.web"
        label="Browser notifications"
        description="A system notification when an agent needs you and Podium is in the background. Applies to your account on every browser."
        value={settings.notifications.web}
        onChange={(web) => patch({ notifications: { ...settings.notifications, web } })}
      />
      {settings.notifications.web && (
        <div className="settings-list-note settings-prose flex items-start gap-2">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div>
            <span>
              {permission === 'default'
                ? 'This browser has not been asked yet.'
                : permission === 'granted'
                  ? 'Notifications are allowed in this browser.'
                  : permission === 'denied'
                    ? 'Blocked in your browser settings — allow them there first.'
                    : 'This browser cannot show notifications.'}
            </span>
            {permission === 'default' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={pending}
                onClick={() => void grant()}
              >
                Allow notifications
              </Button>
            )}
            {error && (
              <p className="mt-1 text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
})
