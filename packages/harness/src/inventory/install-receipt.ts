/**
 * THE RECEIPT OF ONE MANAGED RELEASE (POD-7268).
 *
 * docs/design/harness-managed-installs.md §5.2 and §7. Every published release
 * folder, `<state>/harnesses/<kind>/<number>-<version>/`, holds a
 * `receipt.json`. The folder is the record of the release: a folder with a
 * valid receipt is a release, and nothing else lists them. The ledger names
 * which one is current; when the ledger is lost, it is rebuilt from these.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { type BuiltinHarnessKind, HarnessAgent } from '@podium/model'
import { fsyncPath } from '@podium/runtime/fsync'
import { z } from 'zod'

export const RECEIPT_FILE = 'receipt.json'

/** The receipt's own format number. A receipt with another number is not read. */
export const RECEIPT_FORMAT = 1

/** What proved the download (§5.3 `InstalledRelease.integrity`). */
export const ReleaseIntegrity = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    publishedAt: z.string(),
  }),
  z.object({ kind: z.literal('none'), reason: z.string().min(1) }),
])
export type ReleaseIntegrity = z.infer<typeof ReleaseIntegrity>

/**
 * A version as it may appear in a folder name: no path separators, no `..`,
 * nothing a shell or Windows refuses in a file name.
 */
const FolderSafeVersion = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, 'version is not safe as a folder name')
  .refine((value) => !value.includes('..'), 'version is not safe as a folder name')

/** The executable, relative to the release folder, and inside it. */
const RelativeExecutable = z
  .string()
  .min(1)
  .refine(
    (value) => {
      if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false
      const normal = normalize(value)
      return normal !== '..' && !normal.startsWith(`..${sep}`) && !normal.startsWith('../')
    },
    { message: 'executable must be a path inside the release folder' },
  )

export const InstallReceipt = z.object({
  format: z.literal(RECEIPT_FORMAT),
  harness: HarnessAgent,
  version: FolderSafeVersion,
  /** The executable, relative to the release folder. */
  executable: RelativeExecutable,
  integrity: ReleaseIntegrity,
  /** Where the release was downloaded from. */
  source: z.string().url(),
  /** ISO time the release was published into its folder. */
  installedAt: z.string().datetime({ offset: true }),
})
export type InstallReceipt = z.infer<typeof InstallReceipt>

/** `<number>-<version>`, the name of one release folder. */
export function releaseFolderName(number: number, version: string): string {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`release number must be a positive integer, got ${number}`)
  FolderSafeVersion.parse(version)
  return `${number}-${version}`
}

const RELEASE_FOLDER = /^([1-9][0-9]*)-(.+)$/

/** A numbered folder's parts, or undefined for anything else (`.staging-*`, stray files). */
export function parseReleaseFolderName(
  name: string,
): { number: number; version: string } | undefined {
  const match = RELEASE_FOLDER.exec(name)
  if (!match) return undefined
  const number = Number(match[1])
  if (!Number.isSafeInteger(number)) return undefined
  return { number, version: match[2] as string }
}

/**
 * Write `receipt.json` into a release folder (normally the staging folder,
 * before it is renamed) and flush it to disk. Written to a temporary name and
 * renamed, so a crash never leaves a half-written receipt.
 */
export function writeInstallReceipt(dir: string, receipt: InstallReceipt): void {
  const valid = InstallReceipt.parse(receipt)
  const path = join(dir, RECEIPT_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o644 })
  fsyncPath(temporary)
  renameSync(temporary, path)
  fsyncPath(dir)
}

export type ReadReceiptResult = { ok: true; receipt: InstallReceipt } | { ok: false; error: string }

/** Read and validate a folder's receipt. Never throws. */
export function readInstallReceipt(dir: string): ReadReceiptResult {
  let raw: string
  try {
    raw = readFileSync(join(dir, RECEIPT_FILE), 'utf8')
  } catch (error) {
    return { ok: false, error: `no readable ${RECEIPT_FILE}: ${(error as Error).message}` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `${RECEIPT_FILE} is not JSON: ${(error as Error).message}` }
  }
  const parsed = InstallReceipt.safeParse(json)
  if (!parsed.success)
    return { ok: false, error: `${RECEIPT_FILE} is invalid: ${parsed.error.message}` }
  return { ok: true, receipt: parsed.data }
}

/** One numbered folder under `harnesses/<kind>/`, with what its receipt says. */
export interface ReleaseFolder {
  number: number
  /** The version in the folder's name. */
  version: string
  dir: string
  /** Present when the folder is a release: the receipt is valid, matches the folder and names an existing file. */
  receipt?: InstallReceipt
  /** Why the folder is not a release, when it is not. */
  invalid?: string
}

/**
 * The numbered folders of one harness, highest number first. Staging folders
 * and other names are skipped. A folder counts as a release only when its
 * receipt is valid, names this harness and the folder's version, and its
 * executable exists inside the folder.
 */
export function listReleaseFolders(
  harnessesDir: string,
  kind: BuiltinHarnessKind,
): ReleaseFolder[] {
  const kindDir = join(harnessesDir, kind)
  let names: string[]
  try {
    names = readdirSync(kindDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const folders: ReleaseFolder[] = []
  for (const name of names) {
    const parts = parseReleaseFolderName(name)
    if (!parts) continue
    const dir = join(kindDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    folders.push({ ...parts, dir, ...checkReleaseFolder(dir, kind, parts.version) })
  }
  return folders.sort((a, b) => b.number - a.number)
}

function checkReleaseFolder(
  dir: string,
  kind: BuiltinHarnessKind,
  version: string,
): { receipt: InstallReceipt } | { invalid: string } {
  const read = readInstallReceipt(dir)
  if (!read.ok) return { invalid: read.error }
  const { receipt } = read
  if (receipt.harness !== kind)
    return { invalid: `receipt names ${receipt.harness}, folder is under ${kind}` }
  if (receipt.version !== version)
    return { invalid: `receipt names version ${receipt.version}, folder names ${version}` }
  const executable = join(dir, receipt.executable)
  if (!existsSync(executable)) return { invalid: `executable ${receipt.executable} is missing` }
  return { receipt }
}
