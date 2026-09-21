// packages/harness/src/cursor/chat.ts
//
// CURSOR CHAT ALLOCATION (moved from apps/daemon/src/headless-drivers.ts and
// apps/daemon/src/durable-headless.ts in 1.5: the daemon stops knowing this
// headless harness's session-id allocation).
//
// Cursor's headless mode pins a chat id allocated up front via
// `create-chat`, then always `--resume`s it (`resumeIdAllocation:
// 'create-chat' in the adapter's headless section). The CLI prints the id as
// the last stdout line. The supervisor owns the spawn (in-process child or
// durable exec); this module owns the invocation shape and the id grammar.

import type { ResolvedHarnessInventory } from '../inventory/build-inventory.js'
import { resolvedHarnessPath } from '../executable-runtime.js'

/** The invocation that pre-allocates a headless chat. Nothing else — no
 *  prompt, no flags: allocation is not a turn. */
export function cursorCreateChatInvocation(snapshot: ResolvedHarnessInventory): {
  cmd: string
  args: readonly string[]
} {
  return { cmd: resolvedHarnessPath(snapshot, 'cursor'), args: ['create-chat'] }
}

/**
 * Validate a `create-chat` print. The id rides the last line; anything
 * else-shaped is refused rather than resumed — resuming a non-id would pin
 * the turn to a conversation that does not exist.
 */
export function parseCursorChatId(printed: string): string {
  const id = printed.split('\n').at(-1)?.trim() ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`cursor create-chat did not print a chat id: ${printed.trim()}`)
  }
  return id
}
