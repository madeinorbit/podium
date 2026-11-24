/**
 * Regenerate the current sync kind tokens with the frozen oracle's generations
 * and served effect kinds. Run from the repository root:
 *
 * bun --conditions=@podium/source apps/server/scripts/update-kind-token-fixture.ts
 *
 * Review the schema, code-input and collection-rule changes behind every moved
 * token. The original one-row oracle remains immutable.
 */
import type { SyncRepository } from '@podium/sync'
import frozen from '../src/sync/__fixtures__/one-row-oracles.json'
import { readKindTokens } from '../src/sync/kind-tokens'

const sync = { readKindGenerations: async () => frozen.generations } as Pick<
  SyncRepository,
  'readKindGenerations'
> as SyncRepository
const tokens = await readKindTokens(sync, frozen.effectKinds)
await Bun.write(
  new URL('../src/sync/__fixtures__/kind-tokens.json', import.meta.url),
  `${JSON.stringify(tokens, null, 2)}\n`,
)
