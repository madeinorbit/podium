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
      <WebNotificationsRow settings={settings} patch={patch} />
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
      {/*
        THE BOT TOKEN IS GONE FROM THIS TAB (POD-421, ADR 9 D8 S4).

        It is `notifications.telegramBotToken` — a `secret-value` on the
        `server-owned-secrets` matrix row — and it was rendered here as a
        password input bound to a blob member, beside `telegramChatId`, which is
        a per-user ROUTING address on a different row entirely. One nested
        object, two matrix rows, one form: the exact defect POD-418 split the
        model to end, still visible on screen.

        It now lives on the Secrets surface as presence + fingerprint, which is
        also what makes it admin-managed: the floor is enforced there, on the
        contracted command, rather than being invisible in a shared blob save.
      */}
      <Row
        label="Telegram chat"
        description={
          settings.notifications.telegramChatId.trim()
            ? `Connected — chat ${settings.notifications.telegramChatId}`
            : 'Not connected. Use Connect Telegram below; Podium binds the chat that presents your setup code.'
        }
      >
        {/*
          READ-ONLY, AND THAT IS THE POINT (POD-421, ADR 3 Amendment 1 D22 /
          readiness §3.1.6 S4).

          This was a free-text input. Typing a chat id into it configured a
          delivery address with no ceremony behind it — which is the operator
          fallback the brief forbids reintroducing, arriving as a text box
          rather than as a code path: whoever holds the bot becomes the implied
          identity, and inbound Telegram is now an AUTHENTICATION surface.

          POD-1080 shipped the real ceremony (a claim code minted for the
          authenticated caller, presented to the bot, redeemed into a binding
          whose user comes from the MINT and can come from nowhere else). The
          only honest control here is the one that STARTS that ceremony, so the
          address is displayed and not edited.
        */}
        <span
          className="min-w-0 truncate text-right font-mono settings-micro"
          data-testid="telegram-chat-id"
        >
          {settings.notifications.telegramChatId.trim() || '—'}
        </span>
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
      {/* The heading this block used to carry said "Telegram setup" — the same
          words as the row three lines above it. The steps are what is new here,
          so they say so. */}
      <div className="settings-prose mt-4 border-border border-l pl-3.5">
        <div className="settings-h2 mb-1.5">How to connect</div>
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>
            In Telegram, message <code>@BotFather</code> and use <code>/newbot</code> to create a
            bot. An admin saves its token under{' '}
            <span className="font-medium text-foreground">Secrets</span>.
          </li>
          <li>
            Click <span className="font-medium text-foreground">Connect Telegram</span>. Podium
            shows a Telegram link with a setup code and polls for 5 minutes.
          </li>
          <li>
            Send the prefilled start message. When Podium sees your code it binds that chat to you
            and sends a confirmation. A chat Podium has no binding for is ignored.
          </li>
        </ol>
        <p className="mt-2">
          The chat is bound by the ceremony and cannot be typed in: an address configured without
          one would let whoever holds the bot act as you.
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
    return <p className="settings-prose text-destructive">{setup.message}</p>
  }
  if (setup.status === 'expired') {
    return <p className="settings-prose">Setup expired. Start again.</p>
  }
  if (setup.status === 'connected') {
    const target = setup.chatLabel ?? setup.chatId
    return (
      <p className="inline-flex items-center gap-1.5 text-[13px] text-foreground">
        <CheckCircle2 className="size-3.5 flex-none text-success" /> Connected to {target}.
      </p>
    )
  }

  return (
    <div className="max-w-[62ch] space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2 text-foreground">
        <span>Waiting for Telegram</span>
        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[12px]">
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
  // The sentence explaining the cues is a DESCRIPTION, and it used to sit in the
  // control cell — right-aligned, wrapped into 240px, and touching the switch.
  return (
    <Row
      label="Notification sounds"
      description="Cues on agent done, questions, approvals, and errors. This device only."
    >
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => {
          uiState.set(SOUNDS_ENABLED_KEY, String(checked))
          setEnabled(checked)
          if (checked) play(CUE_SOUNDS.done)
        }}
      />
    </Row>
  )
}

/**
 * Browser permission state belongs to the row's EXPLANATION, not beside its
 * switch. It used to render as a bare span in the control cell — right-aligned
 * against the Switch with no gap (they touched), and it knocked that switch off
 * the right edge every other switch on the screen sits on. The only thing in
 * this cell that is a control is the gesture that grants permission.
 */
function useNotificationPermission(): {
  note: string | null
  grant: (() => void) | null
} {
  const [perm, setPerm] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  if (perm === 'unsupported')
    return { note: 'This browser cannot show notifications.', grant: null }
  if (perm === 'granted') return { note: null, grant: null }
  if (perm === 'denied')
    return { note: 'Blocked in your browser settings — allow them there first.', grant: null }
  return {
    note: 'This browser has not been asked for permission yet.',
    grant: () => void Notification.requestPermission().then(setPerm),
  }
}

function WebNotificationsRow({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  const { note, grant } = useNotificationPermission()
  return (
    <Row
      label="Web notifications"
      description={
        <>
          Desktop notifications from this browser, for agents that need you while Podium is in the
          background.
          {note && <span className="mt-1 block text-warning">{note}</span>}
        </>
      }
    >
      {grant && (
        <Button type="button" variant="outline" size="sm" onClick={grant}>
          Grant permission
        </Button>
      )}
      <Switch
        checked={settings.notifications.web}
        onCheckedChange={(checked) =>
          patch({
            notifications: { ...settings.notifications, web: checked },
          })
        }
      />
    </Row>
  )
}
