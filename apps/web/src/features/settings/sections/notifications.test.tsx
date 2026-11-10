import { normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationsSection,
  TelegramSetupContext,
  type TelegramSetupState,
} from './notifications'

const frame = vi.hoisted(() => ({
  open: vi.fn<(flow: { title: string; content: ReactNode }) => void>(),
  close: vi.fn(),
}))
vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => ({ openTakeover: frame.open, closeTakeover: frame.close }),
}))
vi.mock('../readers', () => ({ useSettingsDraft: () => [true, vi.fn()] }))
vi.mock('@/lib/clock-hooks', () => ({ useCountdown: () => 120_000 }))
vi.mock('sonner', () => ({ toast: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
function props(
  overrides: Partial<ComponentProps<typeof NotificationsSection>> = {},
): ComponentProps<typeof NotificationsSection> {
  return {
    settings: normalizeSettings({}),
    patch: vi.fn(),
    telegramSetup: { status: 'idle' },
    onStartTelegramSetup: vi.fn(),
    onDisconnectTelegram: vi.fn(async () => {}),
    telegramBotPresent: true,
    onRefreshTelegramBot: vi.fn(),
    secrets: { status: 'unavailable' },
    canManageSecrets: false,
    secretBusy: false,
    secretError: null,
    onSetSecret: vi.fn(async () => {}),
    onClearSecret: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('Telegram permission and flow mapping', () => {
  it('lets a member connect without exposing secret management', () => {
    render(<NotificationsSection {...props()} />)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.queryByText('Telegram bot', { exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set up bot' })).toBeNull()
  })
  it('asks an admin when the bot is absent, and offers setup only to admins', () => {
    const p = props({ telegramBotPresent: false })
    const view = render(<NotificationsSection {...p} />)
    expect(screen.getByText('Ask an admin')).toBeTruthy()
    view.rerender(<NotificationsSection {...p} canManageSecrets />)
    expect(screen.queryByText('Ask an admin')).toBeNull()
    expect(screen.getByRole('button', { name: 'Set up bot' })).toBeTruthy()
  })
  it('keeps an open connect takeover subscribed to live ceremony status', () => {
    const p = props()
    const view = render(<NotificationsSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(p.onStartTelegramSetup).toHaveBeenCalledOnce()
    const content = frame.open.mock.calls[0]?.[0].content
    const polling: TelegramSetupState = {
      status: 'polling',
      setupId: 'setup',
      code: 'one-time-code',
      botUsername: 'workspace_bot',
      telegramUrl: 'https://t.me/workspace_bot?start=one-time-code',
      expiresAt: '2026-11-10T10:05:00.000Z',
    }
    view.rerender(
      <TelegramSetupContext.Provider value={polling}>{content}</TelegramSetupContext.Provider>,
    )
    expect(screen.getByRole('link', { name: /Open @workspace_bot/ }).getAttribute('href')).toBe(
      polling.telegramUrl,
    )
    expect(screen.getByRole('status').textContent).toContain('Waiting for your message')
    view.rerender(
      <TelegramSetupContext.Provider
        value={{ status: 'connected', chatId: '123', chatType: 'private', chatLabel: 'My chat' }}
      >
        {content}
      </TelegramSetupContext.Provider>,
    )
    expect(screen.getByRole('status').textContent).toContain('Connected to My chat.')
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })
  it('saves the bot through the secret writer and clears typed material on submit', async () => {
    const p = props({ telegramBotPresent: false, canManageSecrets: true })
    const view = render(<NotificationsSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Set up bot' }))
    view.rerender(frame.open.mock.calls[0]?.[0].content)
    const token = screen.getByLabelText('Paste its token') as HTMLInputElement
    fireEvent.change(token, { target: { value: '123456:new-token' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save bot' }))
    })
    expect(p.onSetSecret).toHaveBeenCalledWith('notifications.telegramBotToken', '123456:new-token')
    expect(token.value).toBe('')
    expect(frame.close).toHaveBeenCalledOnce()
  })
  it('reports a refused disconnect on the Telegram row', async () => {
    const settings = normalizeSettings({ notifications: { telegramChatId: '123' } })
    render(
      <NotificationsSection
        {...props({
          settings,
          onDisconnectTelegram: async () => {
            throw new Error('Connection lost')
          },
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Connection lost'))
  })
})
