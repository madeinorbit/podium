import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  RuntimeEventMessage,
  type RuntimeEventMessage as RuntimeEventFrame,
} from '@podium/protocol/daemon'

const FILE_NAME = 'runtime-event-outbox.json'
const FILE_VERSION = 1

export type DurableRuntimeEvent = RuntimeEventFrame & { deliveryId: string }

export interface RuntimeEventOutbox {
  enqueue(event: DurableRuntimeEvent): void
  acknowledge(deliveryId: string): boolean
  pending(): readonly DurableRuntimeEvent[]
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function parseEvents(raw: string, path: string): DurableRuntimeEvent[] {
  const parsed = JSON.parse(raw) as { version?: unknown; events?: unknown }
  if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.events)) {
    throw new Error(`invalid runtime event outbox: ${path}`)
  }
  return parsed.events.map((value) => {
    const event = RuntimeEventMessage.parse(value)
    if (!event.deliveryId) throw new Error(`runtime event has no delivery id: ${path}`)
    return { ...event, deliveryId: event.deliveryId }
  })
}

/** Synchronous fsync+rename outbox for low-cadence coarse runtime events. */
export function createRuntimeEventOutbox(dir: string): RuntimeEventOutbox {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE_NAME)
  const temporary = `${path}.tmp`
  let events = new Map<string, DurableRuntimeEvent>()

  if (existsSync(temporary)) {
    let recovered: DurableRuntimeEvent[] | undefined
    try {
      recovered = parseEvents(readFileSync(temporary, 'utf8'), temporary)
    } catch (error) {
      if (!existsSync(path)) throw error
    }
    if (recovered) {
      events = new Map(recovered.map((event) => [event.deliveryId, event]))
      renameSync(temporary, path)
      fsyncDirectory(dir)
    } else {
      events = new Map(
        parseEvents(readFileSync(path, 'utf8'), path).map((event) => [event.deliveryId, event]),
      )
    }
  } else if (existsSync(path)) {
    events = new Map(
      parseEvents(readFileSync(path, 'utf8'), path).map((event) => [event.deliveryId, event]),
    )
  }

  const persist = (next: Map<string, DurableRuntimeEvent>): void => {
    const body = `${JSON.stringify({ version: FILE_VERSION, events: [...next.values()] }, null, 2)}\n`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    fsyncDirectory(dir)
  }

  return {
    enqueue(event) {
      const existing = events.get(event.deliveryId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error(`runtime event delivery id collision: ${event.deliveryId}`)
        }
        return
      }
      const next = new Map(events)
      next.set(event.deliveryId, event)
      persist(next)
      events = next
    },
    acknowledge(deliveryId) {
      if (!events.has(deliveryId)) return false
      const next = new Map(events)
      next.delete(deliveryId)
      persist(next)
      events = next
      return true
    },
    pending: () => [...events.values()],
  }
}
