// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE ROOM A COMPACTION NEEDS (POD-7252). The dev.38 update compacted a 3.6 GB
 * database with too little free disk and brought the host down to 726 MB; the
 * old plaintext keys' compaction (`store/legacy-plaintext.ts`) now asks first.
 */

import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { freeDiskBytes } from './backup'

/** What compacting a file needs on disk, and what is free. */
export interface CompactionSpace {
  /** The database file's size now. */
  bytes: number
  /** Bytes needed beside the database: the WAL holds the compacted copy. */
  requiredBeside: number
  /** Bytes needed in SQLite's temporary directory, for the copy built first. */
  requiredTemp: number
  ok: boolean
  /** Why not, when not `ok`. */
  detail?: string
}

/** Kept free after a compaction, so the server can still write. */
const COMPACTION_FLOOR_BYTES = 256 * 1024 * 1024

/** Where SQLite builds a `VACUUM`'s temporary copy on unix (`unixTempFileDir`). */
export function sqliteTempDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of [env.SQLITE_TMPDIR, env.TMPDIR, '/var/tmp', '/usr/tmp', '/tmp']) {
    if (!dir) continue
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch {}
  }
  return '.'
}

/**
 * Can the disk hold a `VACUUM` of `dbPath`? SQLite first builds the compacted
 * copy in its temporary directory, then writes it back through the WAL, so each
 * needs about the file's size (database and WAL as they are now, 10% over),
 * plus a floor left free. On one filesystem the two add up.
 */
export function measureCompactionSpace(
  dbPath: string,
  freeBytes: (dir: string) => number = freeDiskBytes,
  tempDir: string = sqliteTempDir(),
): CompactionSpace {
  const dir = dirname(dbPath)
  const bytes = statSync(dbPath).size
  let size = bytes
  try {
    size += statSync(`${dbPath}-wal`).size
  } catch {}
  const need = Math.ceil(size * 1.1)
  let sameDisk = false
  try {
    sameDisk = statSync(dir).dev === statSync(tempDir).dev
  } catch {}
  const requiredBeside = need + COMPACTION_FLOOR_BYTES + (sameDisk ? need : 0)
  const requiredTemp = sameDisk ? 0 : need
  const beside = freeBytes(dir)
  const temp = sameDisk ? beside : freeBytes(tempDir)
  if (beside < requiredBeside) {
    return {
      bytes,
      requiredBeside,
      requiredTemp,
      ok: false,
      detail: `need ~${requiredBeside} bytes free in ${dir}, only ${beside}`,
    }
  }
  if (temp < requiredTemp) {
    return {
      bytes,
      requiredBeside,
      requiredTemp,
      ok: false,
      detail: `need ~${requiredTemp} bytes free in ${tempDir}, only ${temp}`,
    }
  }
  return { bytes, requiredBeside, requiredTemp, ok: true }
}
