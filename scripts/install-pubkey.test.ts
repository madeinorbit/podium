// scripts/install-pubkey.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PODIUM_UPDATE_PUBKEY } from '../apps/cli/src/podium-update-pubkey'

it('install.sh PUBKEY matches PODIUM_UPDATE_PUBKEY', () => {
  const sh = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8')
  const m = sh.match(/PUBKEY="\$\{PODIUM_INSTALL_PUBKEY:-([^}"]+)\}"/)
  expect(m?.[1]).toBe(PODIUM_UPDATE_PUBKEY)
})
