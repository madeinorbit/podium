/**
 * THE POSTGRES WAKE-UP TRANSPORT [POD-7292, POD-6954 design 4.2].
 *
 * The only file that names `LISTEN` or `NOTIFY` (`workspace-wake-up-guard.test.ts` holds
 * the repository to that). The rest of the server sees {@link WakeUpTransport}.
 *
 * LISTEN ON ONE DEDICATED DIRECT CONNECTION PER PROCESS. A pooler in transaction mode
 * (PgBouncer's port, which the store's pool may be on: `executor/pg-driver.ts`) hands each
 * transaction a different server connection, so a `LISTEN` there listens on a connection
 * the process no longer holds. The listener is a postgres.js client of exactly one
 * connection on the direct URL (`PODIUM_DATABASE_DIRECT_URL`; the store's URL when unset,
 * which is right whenever that URL is not a pooler), outside the store's pool.
 *
 * NOTIFY AFTER THE COMMIT, AS ITS OWN STATEMENT. A commit that contains `NOTIFY` takes a
 * global lock (the notification queue's), which serialises every such commit in the
 * cluster. So the notify is never part of a write: it goes out on a client of its own (one
 * pooled connection, opened at the first publish) that runs nothing else and never opens a
 * transaction, from a post-commit effect, as one autocommitted statement. One statement
 * carries every workspace id the hub batched in a tick, one notification per id, so a
 * burst of commits takes the global lock once. The payload is the workspace id and nothing
 * else.
 *
 * RECONNECT. When the listener's connection closes it is reopened with a bounded backoff
 * and `LISTEN` is sent again; once that succeeds the hub polls every subscribed workspace
 * once, because a notification sent while nobody listened is gone.
 */

import { createLogger } from '@podium/logger'
import type { WorkspaceId } from '@podium/model'
import postgres from 'postgres'
import { PG_CONNECTION_PARAMETERS } from './executor/pg-types'
import type { WakeUpTransport } from './workspace-wake-up'

const log = createLogger('server:wake-up')

/** The one channel every process listens on. The payload names the workspace. */
export const WAKE_UP_CHANNEL = 'podium_workspace_wake_up'

/** The listener connection's `application_name`, so an operator (or a test) can find it. */
export const WAKE_UP_LISTENER_APPLICATION = 'podium-wake-up-listener'
const WAKE_UP_NOTIFIER_APPLICATION = 'podium-wake-up-notifier'

/**
 * One notification per id, in one autocommitted statement. The ids travel as text: a
 * parameter Postgres describes as `json` would be JSON-encoded again by postgres.js's
 * default serializer, and arrive as a JSON string instead of an array.
 */
const NOTIFY_EACH =
  'SELECT pg_notify($1, ids.id) FROM json_array_elements_text(CAST(CAST($2 AS text) AS json)) AS ids(id)'
const LISTEN = `LISTEN ${WAKE_UP_CHANNEL}`

/**
 * The listener's options. `onnotify` is postgres.js's own hook (its `listen` helper is
 * built on it) but missing from its types. The helper itself is not used: when its
 * re-LISTEN after a dropped connection fails, it gives up silently.
 */
type ListenerOptions = postgres.Options<Record<string, never>> & {
  readonly onnotify: (channel: string, payload: string) => void
}

export interface PgWakeUpTransportOptions {
  /** Where the listener connects: a direct connection, never a transaction pooler. */
  readonly listenUrl: string
  /** Where notifications are sent from; may be the pooler. */
  readonly notifyUrl: string
  /** Seconds a connection may take to open. Default 10. */
  readonly connectTimeoutSeconds?: number
  /** Reconnect delays of the listener: first and largest, in ms. Default 100 and 5,000. */
  readonly reconnectDelayMs?: { readonly initial: number; readonly max: number }
}

export function pgWakeUpTransport(options: PgWakeUpTransportOptions): WakeUpTransport {
  const connectTimeout = options.connectTimeoutSeconds ?? 10
  const initialDelay = options.reconnectDelayMs?.initial ?? 100
  const maxDelay = options.reconnectDelayMs?.max ?? 5_000
  let closed = false
  let listener: postgres.Sql | undefined
  let notifier: postgres.Sql | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let listening: Promise<void> | undefined

  const openNotifier = (): postgres.Sql =>
    (notifier ??= postgres(options.notifyUrl, {
      max: 1,
      prepare: true,
      connect_timeout: connectTimeout,
      connection: { ...PG_CONNECTION_PARAMETERS, application_name: WAKE_UP_NOTIFIER_APPLICATION },
      onnotice: () => undefined,
    }))

  return {
    kind: 'postgres',

    listen(receive, onReady) {
      if (listener !== undefined || closed) return
      let delay = initialDelay
      const subscribe = async (): Promise<void> => {
        if (closed || listener === undefined) return
        try {
          await listener.unsafe(LISTEN)
          delay = initialDelay
          onReady()
        } catch (err) {
          if (closed) return
          log.warn('workspace wake-up listener could not listen; retrying', { delayMs: delay, err })
          scheduleRelisten()
        }
      }
      const scheduleRelisten = (): void => {
        if (closed || reconnectTimer !== undefined) return
        const wait = delay
        delay = Math.min(maxDelay, delay * 2)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          listening = subscribe()
        }, wait)
        reconnectTimer.unref?.()
      }
      const listenerOptions: ListenerOptions = {
        max: 1,
        // The listen state belongs to the connection: never recycle it on our own (no
        // idle timeout is the default; the default lifetime is 30 to 60 minutes).
        max_lifetime: null,
        prepare: false,
        fetch_types: false,
        connect_timeout: connectTimeout,
        connection: {
          ...PG_CONNECTION_PARAMETERS,
          application_name: WAKE_UP_LISTENER_APPLICATION,
        },
        onnotice: () => undefined,
        onnotify: (channel, payload) => {
          if (channel === WAKE_UP_CHANNEL && payload.length > 0) receive(payload as WorkspaceId)
        },
        // The connection dropped (the server restarted, the network, a terminated
        // backend). postgres.js reconnects at the next statement; the LISTEN is ours.
        onclose: () => {
          if (closed) return
          log.info('workspace wake-up listener connection closed; listening again')
          scheduleRelisten()
        },
      }
      listener = postgres(
        options.listenUrl,
        listenerOptions as postgres.Options<Record<string, never>>,
      )
      listening = subscribe()
    },

    async send(workspaceIds) {
      if (closed || workspaceIds.length === 0) return
      await openNotifier().unsafe(NOTIFY_EACH, [WAKE_UP_CHANNEL, JSON.stringify(workspaceIds)], {
        prepare: true,
      })
    },

    async close() {
      if (closed) return
      closed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      await listening?.catch(() => undefined)
      await Promise.all([listener?.end({ timeout: 5 }), notifier?.end({ timeout: 5 })])
    },
  }
}
