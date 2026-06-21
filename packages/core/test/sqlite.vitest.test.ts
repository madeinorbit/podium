import { describe, expect, it } from 'vitest'
import { sqliteShimSpec } from '../src/sqlite/sqlite-spec'

sqliteShimSpec({ describe, it, expect })
