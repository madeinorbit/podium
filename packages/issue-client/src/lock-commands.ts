import { z } from 'zod'
import type { IssueCommand, IssueCommandResult } from './commands.js'

/**
 * The `podium lock` command table [spec:SP-85d1] — presentation (verbs,
 * positionals, render bodies) over the server's advisory named-lease locks
 * (`lock.*` procs). Same shape as ISSUE_COMMANDS so the CLI dispatcher
 * (apps/cli/src/lock-cli.ts) reuses the parse → validate → run → render flow.
 *
 * Locks are purely advisory coordination tokens: nothing here (or server-side)
 * refuses a git merge — scripts branch on the exit code instead.
 */

/** Default lease TTL: 2 minutes. */
export const DEFAULT_LOCK_TTL_SECONDS = 120

/** Parse a human TTL (`10m`, `30s`, `2h`, bare seconds `600`) to seconds. */
export function parseTtl(raw: string): number {
  const m = /^(\d+)([smh]?)$/.exec(raw.trim())
  if (!m) throw new Error(`invalid --ttl '${raw}' (use e.g. 10m, 30s, 2h, or seconds)`)
  const n = Number(m[1])
  const mult = m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1
  const seconds = n * mult
  if (seconds <= 0) throw new Error(`invalid --ttl '${raw}': must be positive`)
  return seconds
}

// ---- wire shapes (mirror apps/server/src/modules/lock/service.ts outputs) ----

interface HolderWire {
  sessionId: string | null
  issueId: string | null
  label: string
}

interface QueueEntryWire extends HolderWire {
  position: number
  enqueuedAt: string
}

interface LockWire {
  repoId: string
  name: string
  holder: HolderWire
  note: string | null
  acquiredAt: string
  expiresAt: string
  secondsLeft: number
  queue: QueueEntryWire[]
}

type AcquireWire =
  | { granted: true; alreadyHeld: boolean; lock: LockWire }
  | { granted: false; position: number; lock: LockWire }

const fmtSeconds = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`)

function holderLine(l: LockWire): string {
  return `held by ${l.holder.label}${l.note ? ` (${l.note})` : ''}, expires in ${fmtSeconds(l.secondsLeft)}`
}

function renderStatus(l: LockWire): string {
  const queue = l.queue.length
    ? `\nqueue:\n${l.queue.map((w) => `  ${w.position}. ${w.label} (since ${w.enqueuedAt})`).join('\n')}`
    : ''
  return `'${l.name}' ${holderLine(l)} (acquired ${l.acquiredAt})${queue}`
}

const nameArg = { name: z.string().min(1) }
const repoArg = { repoPath: z.string() }
const ttlArg = { ttl: z.string().optional() }

const ttlSeconds = (a: Record<string, unknown>): number | undefined =>
  a.ttl != null ? parseTtl(String(a.ttl)) : undefined

/** The `podium lock` commands. `--wait`/`--timeout` on acquire are handled by the
 *  CLI dispatcher (a poll loop over this same acquire body), not here. */
export const LOCK_COMMANDS: IssueCommand[] = [
  {
    name: 'acquire',
    summary:
      'Acquire (or renew) a named lease lock: acquire <name> [--ttl 10m] [--note "…"] [--wait [--timeout 300]]. Queued if held by someone else.',
    args: z.object({
      ...nameArg,
      ...repoArg,
      ...ttlArg,
      note: z.string().optional(),
      wait: z.boolean().optional(),
      timeout: z.union([z.string(), z.number()]).optional(),
    }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.acquire.mutate({
        repoPath: a.repoPath as string,
        name: a.name as string,
        ...(ttlSeconds(a) != null ? { ttlSeconds: ttlSeconds(a) } : {}),
        ...(a.note != null ? { note: a.note as string } : {}),
      })) as AcquireWire
      if (r.granted) {
        return {
          text: r.alreadyHeld
            ? `already held: renewed '${r.lock.name}' (expires in ${fmtSeconds(r.lock.secondsLeft)})`
            : `acquired '${r.lock.name}' (expires in ${fmtSeconds(r.lock.secondsLeft)})`,
          data: r,
        }
      }
      return {
        text: `queued for '${r.lock.name}' at position ${r.position}; ${holderLine(r.lock)}`,
        data: r,
      }
    },
  },
  {
    name: 'cancel',
    summary:
      "Leave a lock's wait queue: cancel <name>. Errors if you are not queued (a holder uses release).",
    args: z.object({ ...nameArg, ...repoArg }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.cancel.mutate({
        repoPath: a.repoPath as string,
        name: a.name as string,
      })) as { cancelled: true }
      return { text: `left the queue for '${a.name}'`, data: r }
    },
  },
  {
    name: 'release',
    summary: 'Release a lock you hold: release <name>. The next queued waiter is granted.',
    args: z.object({ ...nameArg, ...repoArg }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.release.mutate({
        repoPath: a.repoPath as string,
        name: a.name as string,
      })) as { released: true; next: HolderWire | null }
      return {
        text: `released '${a.name}'${r.next ? `; granted to ${r.next.label}` : ''}`,
        data: r,
      }
    },
  },
  {
    name: 'renew',
    summary: 'Extend the lease on a lock you hold: renew <name> [--ttl 10m].',
    args: z.object({ ...nameArg, ...repoArg, ...ttlArg }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.renew.mutate({
        repoPath: a.repoPath as string,
        name: a.name as string,
        ...(ttlSeconds(a) != null ? { ttlSeconds: ttlSeconds(a) } : {}),
      })) as LockWire
      return { text: `renewed '${r.name}' (expires in ${fmtSeconds(r.secondsLeft)})`, data: r }
    },
  },
  {
    name: 'status',
    summary: 'Show lock state: status [<name>]. Without a name, lists all locks in the repo.',
    args: z.object({ name: z.string().optional(), ...repoArg }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.status.query({
        repoPath: a.repoPath as string,
        ...(a.name != null ? { name: a.name as string } : {}),
      })) as LockWire[]
      if (a.name != null) {
        const l = r[0]
        return l ? { text: renderStatus(l), data: l } : { text: `'${a.name}' is free`, data: null }
      }
      return {
        text: r.length
          ? r.map((l) => `${l.name}: ${holderLine(l)} queue=${l.queue.length}`).join('\n')
          : '(no locks held)',
        data: r,
      }
    },
  },
  {
    name: 'steal',
    summary:
      'Force-take a lock regardless of holder (humans/stuck cases): steal <name> [--ttl 10m] [--note "…"]. Logged; previous holder is mailed.',
    args: z.object({ ...nameArg, ...repoArg, ...ttlArg, note: z.string().optional() }),
    positionals: ['name'],
    async run(c, a): Promise<IssueCommandResult> {
      const r = (await c.lock.steal.mutate({
        repoPath: a.repoPath as string,
        name: a.name as string,
        ...(ttlSeconds(a) != null ? { ttlSeconds: ttlSeconds(a) } : {}),
        ...(a.note != null ? { note: a.note as string } : {}),
      })) as { lock: LockWire; previousHolder: HolderWire | null }
      return {
        text: r.previousHolder
          ? `stole '${r.lock.name}' from ${r.previousHolder.label} (expires in ${fmtSeconds(r.lock.secondsLeft)})`
          : `acquired '${r.lock.name}' (was free; expires in ${fmtSeconds(r.lock.secondsLeft)})`,
        data: r,
      }
    },
  },
]

/** Type re-exports for renderers/tests that want the wire shapes. */
export type { AcquireWire, HolderWire, LockWire, QueueEntryWire }
