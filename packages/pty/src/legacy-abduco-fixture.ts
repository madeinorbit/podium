import { existsSync } from 'node:fs'

/**
 * Tests only. Supply an abduco built from a released version's source before
 * running legacy adoption tests. The product no longer vendors or builds it.
 */
export const legacyAbducoBin = process.env.PODIUM_TEST_ABDUCO_BIN
export const oldAbducoBin = process.env.PODIUM_TEST_ABDUCO_OLD_BIN
export const hasLegacyAbduco = !!legacyAbducoBin && existsSync(legacyAbducoBin)
