import { describe, expect, it } from 'vitest'
import { sqliteShimSpec } from '../src/sqlite/sqlite-spec'
import { transactionSpec } from '../src/sqlite/transaction-spec'

sqliteShimSpec({ describe, it, expect })
transactionSpec({ describe, it, expect })
