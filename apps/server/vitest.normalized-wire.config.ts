import { createServerShardConfig } from './vitest.shard'

/**
 * The server's normalized-wire pair, as its own cache unit. It stays IN the default gate
 * and keeps the root lane's one-worker load guard — see `createServerShardConfig`, which
 * serializes this shard specifically. Sharding it means giving it an independent Turbo
 * hash, never moving it out of `bun run test` or relaxing it.
 */
export default createServerShardConfig('normalized-wire')
