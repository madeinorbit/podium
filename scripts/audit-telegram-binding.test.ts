/**
 * THE RUNNING-OBJECT HALF of the telegram identity-binding audit (POD-1080).
 *
 * `scripts/audit-telegram-binding.ts` reads source TEXT and resolves no modules,
 * so it runs in a fresh checkout — and can be fooled by a file nobody imports.
 * This file resolves the REAL objects the server will serve and the REAL
 * function it will resolve identities with. Neither instrument can be fooled the
 * way the other can, which is the whole reason there are two.
 *
 * It lives here rather than inside the script because these worktrees carry a
 * `node_modules` with no `@podium` scope: a script that imported the workspace
 * would read another checkout or fail outright. `audit-scoped-feed.ts` splits
 * the same way, for the same mechanical reason.
 *
 * The source arm's own checks are exercised here too, against the REAL tree —
 * so a gate whose `--probe` passes on fixtures while its scan misses the shipped
 * files is a failure here rather than a serene zero in CI.
 */

// A RELATIVE import: `scripts/` is not a workspace package and `vitest.config.ts`
// aliases `@podium/model` and `@podium/runtime` but deliberately not
// `@podium/commands`, so the package name does not resolve from here. The file's
// own `@podium/model` import resolves through the alias, which is why this reads
// the same objects the server does rather than a second copy.
import { SETTINGS_CONTRACTS } from '../packages/commands/src/settings/contracts'
import { asUserId, resolveTelegramPrincipal } from '@podium/model'
import type { TelegramChatBinding } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { auditSources, probe } from './audit-telegram-binding'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const bind = (userId: typeof ALICE, chatId: string): TelegramChatBinding => ({
  userId,
  chatId,
  boundAt: '2026-07-31T00:00:00.000Z',
  boundBy: { actor: { kind: 'user', id: userId }, onBehalfOf: userId },
})

describe('the source arm is honest about the REAL tree', () => {
  it('every source check can say YES against its planted fixture', () => {
    // The script runs this itself on every invocation; asserting it here too
    // means a broken instrument reddens the test lane, not only the gate lane.
    expect(probe()).toEqual([])
  })

  it('finds nothing on the shipped tree', () => {
    expect(auditSources()).toEqual([])
  })
})

describe('served — the ceremony contracts reach a dispatcher', () => {
  // POD-385's defect: three contracts declared a transport nothing derived, and
  // the issue closed looking complete. A contract table with no dispatcher is
  // mechanism without coverage.
  for (const name of ['settings.telegramSetupStart', 'settings.telegramSetupPoll'] as const) {
    it(`${name} is classified and exposed on trpc`, () => {
      const contract = SETTINGS_CONTRACTS[name]
      expect(contract).toBeDefined()
      expect(contract.exposure).toContain('trpc')
    })
  }

  it('and the derived router actually serves both keys', async () => {
    // The other direction, against the object the server builds. The derived
    // surface asserts membership in BOTH directions at module load, so an
    // exposure declared with no procedure throws before a request is answered —
    // this proves that assertion ran and passed for these two.
    const { settingsFamilyProcedures } = await import(
      '../apps/server/src/modules/settings/trpc'
    )
    const built = settingsFamilyProcedures() as unknown as Record<string, unknown>
    expect(Object.keys(built)).toContain('telegramSetupStart')
    expect(Object.keys(built)).toContain('telegramSetupPoll')
  })

  it('the derived surface is not simply everything — the check can say NO', () => {
    // Non-vacuity: `settings.get` is a read with no contract, so it must NOT
    // appear. Without this, a surface that served every name would pass above.
    expect(Object.keys(SETTINGS_CONTRACTS)).not.toContain('settings.get')
  })
})

describe('resolver-decides — the SHIPPED resolver, not a restatement of it', () => {
  it('resolves a bound chat', () => {
    expect(resolveTelegramPrincipal([bind(ALICE, '-1')], '-1')).toEqual({ ok: true, userId: ALICE })
  })

  it('REFUSES an unbound chat — the fail-open no source check could see', () => {
    expect(resolveTelegramPrincipal([bind(ALICE, '-1')], '-2').ok).toBe(false)
  })

  it('REFUSES to elect a user when two bindings name one chat', () => {
    expect(resolveTelegramPrincipal([bind(ALICE, '-1'), bind(BOB, '-1')], '-1').ok).toBe(false)
  })
})
