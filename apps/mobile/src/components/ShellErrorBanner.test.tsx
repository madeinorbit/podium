/**
 * A PHONE ERROR NOTICE IS SHOWN ON WHATEVER SCREEN IS UP (POD-4662).
 *
 * POD-4660 made a queued send to a deleted session resolve and tell the
 * operator "Message not sent — the session no longer exists: …". On a real
 * phone the words never appeared: the engine's `notices.error` set
 * `shell.error`, and the only reader of that field was the Inbox screen, which
 * no route mounts. Every mobile error notice was invisible.
 *
 * These tests drive the notice the way production does — a REAL store over a
 * memory replica, handed the composition root's own error channel as its
 * `notices`, under the composition root's own `MobileShellSurface` — and put
 * on screen only a route that knows nothing about the shell. A notice that
 * shows here is shown by the shell, not by a screen.
 */

import { type SessionMeta, asSessionId, UNADDRESSABLE_SEND_REASON } from '@podium/model'
import { useStoreSelector } from '@podium/client-core/react'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}))

const GONE = asSessionId('s-gone')

const deleted = {
  sessionId: GONE,
  agentKind: 'claude-code',
  cwd: '/repo',
  status: 'live',
  title: 'Agent',
} as unknown as SessionMeta

/** What the session screen shows once the desktop deleted its session. It
 *  reads nothing from the shell, which is the point. */
let send: ((text: string) => Promise<void>) | null = null
function DeletedSessionRoute() {
  const resumeAndSend = useStoreSelector((s) => s.resumeAndSend)
  send = (text) => resumeAndSend(GONE, text)
  return <Text>Session deleted. It was removed on the server.</Text>
}

/** The server after the session was deleted: every send to it is answered
 *  with the dead-letter reply POD-4660 resolves. */
function deletedSessionAuthority() {
  const sends: string[] = []
  const api = {
    sessions: {
      transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
      resumeAndSend: {
        mutate: async (input: { text: string }) => {
          sends.push(input.text)
          return { ok: false, reason: UNADDRESSABLE_SEND_REASON, disposition: 'dead_letter' }
        },
      },
    },
  }
  return { api, sends }
}

describe('phone error notices', () => {
  it('a send to a deleted session says "Message not sent" over the route, until dismissed', async () => {
    const { api, sends } = deletedSessionAuthority()
    await renderWithMobileStore(<DeletedSessionRoute />, {
      liveShell: true,
      sessions: [deleted],
      api,
    })
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      await send?.('Write the numbers from 1 to 400')
    })

    await waitFor(() => expect(sends).toEqual(['Write the numbers from 1 to 400']))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toBe(
      'Message not sent — the session no longer exists: “Write the numbers from 1 to 400”',
    )
    // The route is still there under it: the notice is drawn OVER the screen
    // the operator is on, not instead of it.
    expect(screen.getByText('Session deleted. It was removed on the server.')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss error'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('a later error replaces the one before it and is dismissed on its own', async () => {
    const { api } = deletedSessionAuthority()
    await renderWithMobileStore(<DeletedSessionRoute />, {
      liveShell: true,
      sessions: [deleted],
      api,
    })

    await act(async () => {
      await send?.('first')
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('“first”'))
    await act(async () => {
      await send?.('second')
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('“second”'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Dismiss error'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
