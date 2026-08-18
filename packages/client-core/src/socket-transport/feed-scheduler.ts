import { hasMessageChannel } from '../platform-globals'

/**
 * THE FEED'S MACROTASK, AND WHY IT IS NOT A TIMER (POD-2058 F6).
 *
 * `SocketHub` hands one feed envelope per scheduled task back to the event loop,
 * so the browser can service input and paint between bootstrap chunks. That
 * boundary was `setTimeout(task, 0)`, which every browser clamps to ≥1 s once the
 * tab is hidden — so a backgrounded tab drained ONE FRAME PER SECOND while frames
 * kept arriving at full speed, and a reconnect while hidden could blow the 30 s
 * bootstrap-chunk timeout on scheduling alone.
 *
 * `MessageChannel.postMessage` is the same kind of macrotask and is NOT clamped:
 * it still yields between envelopes, it just yields at the speed the work
 * actually takes. (This is why React's scheduler drives its own time slicing off
 * a MessageChannel rather than a timer.)
 *
 * The timer stays as the fallback for hosts with no `MessageChannel` — nothing
 * clamps timers there, so the fallback costs nothing where it is used.
 */
export interface FeedTaskScheduler {
  /** Run `task` on a future macrotask. Tasks run in the order scheduled. */
  schedule(task: () => void): void
  /** Drop anything pending and release the underlying channel. */
  dispose(): void
}

/**
 * Node's `MessagePort` holds the event loop open while it is listening; the DOM's
 * has no such notion and no `ref`/`unref`. Optional, so the same code holds the
 * loop open only while a feed task is genuinely pending under Node and does
 * nothing at all in a browser.
 */
type LoopAwarePort = MessagePort & { ref?: () => void; unref?: () => void }

export function createFeedTaskScheduler(): FeedTaskScheduler {
  return hasMessageChannel() ? messageChannelScheduler() : timerScheduler()
}

function messageChannelScheduler(): FeedTaskScheduler {
  const pending: Array<() => void> = []
  let channel: MessageChannel | undefined
  let disposed = false

  return {
    schedule(task: () => void): void {
      if (disposed) return
      if (channel === undefined) {
        const opened = new MessageChannel()
        const inbound = opened.port1 as LoopAwarePort
        inbound.onmessage = () => {
          const next = pending.shift()
          try {
            next?.()
          } finally {
            // After the task, so a task that scheduled its successor — which is
            // exactly what the ingress drain does — keeps the loop held.
            if (pending.length === 0) inbound.unref?.()
          }
        }
        channel = opened
      }
      pending.push(task)
      ;(channel.port1 as LoopAwarePort).ref?.()
      channel.port2.postMessage(0)
    },
    dispose(): void {
      disposed = true
      pending.length = 0
      channel?.port1.close()
      channel?.port2.close()
      channel = undefined
    },
  }
}

function timerScheduler(): FeedTaskScheduler {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  return {
    schedule(task: () => void): void {
      if (disposed) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        task()
      }, 0)
      timers.add(timer)
    },
    dispose(): void {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}
