// Run ONLY under `bun test` — exercises the same shim spec against bun:sqlite.
import { describe, expect, it } from 'bun:test'
import { sqliteShimSpec } from '../src/sqlite/sqlite-spec'

sqliteShimSpec({ describe, it, expect })
