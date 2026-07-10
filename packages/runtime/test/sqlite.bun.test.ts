// Run ONLY under `bun test` — exercises the same shim spec against bun:sqlite.
import { describe, expect, it } from 'bun:test'
import { sqliteShimSpec } from '../src/sqlite/sqlite-spec'
import { transactionSpec } from '../src/sqlite/transaction-spec'

sqliteShimSpec({ describe, it, expect })
transactionSpec({ describe, it, expect })
