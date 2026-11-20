/**
 * THE NOTICE INBOX COMMANDS (POD-6881, credential management spec §13).
 *
 * `notices.markRead` and `notices.markAllRead` change the CALLER's own notices
 * only: a notice id that is somebody else's is as unknown as one that never
 * existed, an admin's call included. Both are a person's acts, refused for an
 * agent: a notice is for the human, and an agent marking it read would hide it
 * from them. Raising and resolving notices is the server's (`emitNotice`,
 * `resolveNotices`); no client command does either.
 *
 * Sent on `sync.submit` over tRPC. The notice rows reach the caller's devices
 * through the synced record `inboxNotice`, so the answer carries only what
 * changed.
 */

import { z } from 'zod'
import { type CommandDef, defineCommands } from '../framework'

export const noticeMarkReadInput = z.object({ id: z.string().min(1).max(200) })
export type NoticeMarkReadInput = z.infer<typeof noticeMarkReadInput>

export const noticeMarkAllReadInput = z.object({}).passthrough()

/** `notices.list`: the caller's open notices, newest first, a page at a time. */
export const noticeListInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  /** The last notice of the previous page. */
  before: z.object({ createdAt: z.string(), id: z.string() }).optional(),
})
export type NoticeListInput = z.infer<typeof noticeListInput>

const SERVED_ON = ['trpc'] as const

export const noticeCommands = defineCommands('notices', {
  markRead: {
    input: noticeMarkReadInput,
    action: 'write',
    exposure: SERVED_ON,
    conflict: 'single-writer',
    visibility: 'per-user-state',
    policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
    cli: { summary: 'Mark one of my notices read.' },
  },
  markAllRead: {
    input: noticeMarkAllReadInput,
    action: 'write',
    exposure: SERVED_ON,
    conflict: 'single-writer',
    visibility: 'per-user-state',
    policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
    cli: { summary: 'Mark all my notices read.' },
  },
} satisfies Record<'markRead' | 'markAllRead', CommandDef>)

export const NOTICE_SYNC_COMMANDS = ['notices.markRead', 'notices.markAllRead'] as const
