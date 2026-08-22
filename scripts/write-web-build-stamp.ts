/**
 * STAMP A BUILT WEB DIST WITH THE SCHEMA IT CONTAINS (POD-1610) AND THE
 * PRODUCT VERSION OPERATORS SEE.
 *
 * BOTH WEBSITES, ONE STAMP. Podium serves two built dists — the desktop shell
 * from `vite build`, and the phone shell from `expo export -p web` — and this
 * script stamps either, because "which commit is this dist" is one question and
 * an installation whose phone cannot answer it is an installation Update cannot
 * bring current (POD-1980). The only toolchain-specific part is the entry chunk
 * hash, and that lives in `bundleVersionFromHtml`, not here.
 *
 * Writes `podium-build.json` beside index.html, carrying:
 * - `wireSchemaDigest()` — protocol compatibility
 * - `appVersion` — product version: `PODIUM_APP_VERSION` or `dev+<sourceSha>`
 * - `sourceSha` — `git rev-parse --short=7 HEAD`, `artifacts.web.digest`
 * - `bundleVersion` — `bundle+<entry chunk hash>`, forensic only
 *
 * It also writes `podium-build-manifest.json`: the exact SHA-256 inventory of
 * every other shipped file, bound to this source commit and full build stamp.
 *
 * The Update panel, About, `/version`, and log field `v` all read `appVersion`.
 * `wireSchemaDigest` is not that identity — UI-only commits keep the same
 * protocol digest. `bundleVersion` is not that identity either — it names
 * the emitted chunk a crash stack already prints.
 *
 * Also writes the product version and source digest into the HTML so the
 * running page can synchronously display the former and compare the latter
 * without fetching a stamp that may have changed since this page loaded.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT A VITE PLUGIN
 * ---------------------------------------------------------------------------
 *
 * The obvious form is a plugin in `apps/web/vite.config.ts`, and it was written
 * that way first. Vite bundles its own config with dependencies EXTERNALIZED, so
 * importing the protocol source there makes the config load depend on
 * `packages/model` having a built `dist` — and it fails outright when it does
 * not. A stamping step that breaks the build in a fresh checkout is a worse
 * defect than the one it detects. Bun runs the source directly, so the stamp is
 * taken here, right after `vite build`, in the same package script.
 *
 * ---------------------------------------------------------------------------
 * THE STAMP MUST COME FROM THE SAME SOURCE THE BUNDLE DID
 * ---------------------------------------------------------------------------
 *
 * `vite.config.ts` aliases `@podium/protocol` and `@podium/model` to THESE files
 * by absolute path, because a bare package name resolves by walking up the
 * filesystem and can land in a sibling checkout's node_modules — POD-746, where a
 * build exited 0 having bundled code that was not the code under review. This
 * script imports the protocol by the same relative path for the same reason, and
 * REFUSES to write a stamp when `@podium/model` resolves outside this repository:
 * a fingerprint taken from a different copy than the bundle contains would
 * certify the wrong artefact, and a wrong certificate is worse than none.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import {
  BUILD_STAMP_FILE,
  type BuildStamp,
  bundleVersionFromHtml,
  PRODUCT_VERSION_META,
  resolveProductVersion,
  SOURCE_DIGEST_META,
  WIRE_VERSION,
  wireSchemaDigest,
} from '../packages/protocol/src/index'
import { developmentSourceSha } from '../packages/runtime/src/source-version'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export const CLIENT_BUILD_MANIFEST_FILE = 'podium-build-manifest.json'

export interface ClientBuildManifest {
  manifestVersion: 1
  sourceCommit: string
  /** Opaque nonce supplied by a packaging invocation that requires freshness evidence. */
  buildInvocation?: string
  buildStamp: WrittenBuildStamp
  /** SHA-256 of every shipped regular file except this self-referential manifest. */
  files: Record<string, string>
}

export type WrittenBuildStamp = BuildStamp & {
  wireSchemaDigest: string
  wireVersion: number
  builtAt: string
  appVersion: string
}

/** Where `@podium/model` actually came from for THIS process. The protocol
 *  schemas import it as a value (the feed's entity payload arms), so a stamp
 *  taken with a foreign model is a stamp of a wire nobody is serving. */
function resolvedModelPath(): string {
  try {
    return fileURLToPath(import.meta.resolve('@podium/model'))
  } catch {
    return ''
  }
}

/** Checkout SHA at build time. Omitted when git cannot name HEAD. */
export function resolveWebSourceSha(
  root: string,
  readHead?: (root: string) => string,
): string | undefined {
  return readHead ? developmentSourceSha(root, readHead) : developmentSourceSha(root)
}

const EXISTING_META = /<meta\s+name=["']podium-version["'][^>]*>/i
const EXISTING_SOURCE_META = /<meta\s+name=["']podium-source-digest["'][^>]*>/i

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Put the product version in the HTML the page will read. */
export function injectProductVersionMeta(html: string, version: string): string {
  const tag = `<meta name="${PRODUCT_VERSION_META}" content="${escapeAttr(version)}">`
  if (EXISTING_META.test(html)) return html.replace(EXISTING_META, tag)
  if (html.includes('</head>')) return html.replace('</head>', `  ${tag}\n</head>`)
  return `${tag}\n${html}`
}

/** Put the source identity in the HTML so the loaded page can be compared after a redeploy. */
export function injectSourceDigestMeta(html: string, digest: string): string {
  const tag = `<meta name="${SOURCE_DIGEST_META}" content="${escapeAttr(digest)}">`
  if (EXISTING_SOURCE_META.test(html)) return html.replace(EXISTING_SOURCE_META, tag)
  if (html.includes('</head>')) return html.replace('</head>', `  ${tag}\n</head>`)
  return `${tag}\n${html}`
}

/**
 * The stamp a built `index.html` earns. Pure, and exported, so the contract the
 * page depends on can be asserted without a build (and without spawning this
 * script, which a worktree with no `node_modules` cannot do — the POD-746 guard
 * below fires first).
 *
 * `appVersion` is the product version. A missing hashed entry is no longer a
 * missing product identity — the chunk hash is `bundleVersion`, and a dest
 * checkout without a hash can still be `dev+<sha>`. The build still fails when
 * a real `vite build` produced no hashed entry, because that means the
 * assumption `bundleVersion` rests on has moved.
 */
export function webBuildStamp(
  indexHtml: string,
  now: Date = new Date(),
  sourceSha?: string,
  packagedVersion?: string,
): WrittenBuildStamp {
  const bundleVersion = bundleVersionFromHtml(indexHtml)
  const appVersion = resolveProductVersion(packagedVersion, sourceSha)
  return {
    wireSchemaDigest: wireSchemaDigest(),
    wireVersion: WIRE_VERSION,
    builtAt: now.toISOString(),
    appVersion,
    ...(sourceSha ? { sourceSha } : {}),
    ...(bundleVersion ? { bundleVersion } : {}),
  }
}

/**
 * Rewrite the `.br`/`.gz` siblings of a file whose bytes just changed.
 *
 * This step is LAST in the build (POD-1986), so `podium-build.json` can mean what
 * every reader already assumes — the dist is complete. That puts it AFTER
 * `precompress-dist.ts`, and rewriting index.html leaves the compressed copies of
 * the page stale. The server serves those straight off disk in preference to the
 * original (apps/server/src/static-web.ts), so a stale sibling is not a cosmetic
 * mismatch: it is the version meta the page actually reports being one build old.
 *
 * Only siblings that ALREADY exist are refreshed. Precompression deliberately skips
 * files under 1 KB and outputs that failed to shrink, and inventing a `.br` here
 * would quietly overrule that. Settings match precompress-dist.ts — the cost is one
 * 3 KB page, not the 36 MB dist.
 */
function refreshCompressedSiblings(filePath: string, bytes: string): void {
  const raw = Buffer.from(bytes)
  if (existsSync(`${filePath}.br`)) {
    writeFileSync(
      `${filePath}.br`,
      brotliCompressSync(raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
        },
      }),
    )
  }
  if (existsSync(`${filePath}.gz`)) {
    writeFileSync(`${filePath}.gz`, gzipSync(raw, { level: 9 }))
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Describe the exact completed client dist. The manifest excludes only itself
 * (a file cannot contain its own digest), and predicts the stamp bytes written
 * immediately after it so `podium-build.json` remains the completion marker.
 */
function clientBuildManifest(
  distDir: string,
  stamp: WrittenBuildStamp,
  stampBytes: string,
  buildInvocation?: string,
): ClientBuildManifest {
  if (!stamp.sourceSha) {
    throw new Error('cannot write a client build manifest without a source commit')
  }
  const files: Record<string, string> = {}
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = relative(distDir, path).split(sep).join('/')
      if (name === CLIENT_BUILD_MANIFEST_FILE || name === BUILD_STAMP_FILE) continue
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !lstatSync(path).isFile()) {
        throw new Error(`client dist contains unsupported non-regular entry ${name}`)
      }
      files[name] = sha256(readFileSync(path))
    }
  }
  visit(distDir)
  files[BUILD_STAMP_FILE] = sha256(stampBytes)
  return {
    manifestVersion: 1,
    sourceCommit: stamp.sourceSha,
    ...(buildInvocation ? { buildInvocation } : {}),
    buildStamp: stamp,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  }
}

export function writeWebBuildStamp(
  distDir: string,
  now: Date = new Date(),
  sourceSha?: string,
  packagedVersion?: string,
  buildInvocation?: string,
): WrittenBuildStamp {
  const indexPath = join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`${distDir} has no index.html — did the build run?`)
  }
  const indexHtml = readFileSync(indexPath, 'utf8')
  if (!bundleVersionFromHtml(indexHtml)) {
    throw new Error(
      'no hashed entry script in index.html, so this build has no forensic ' +
        'bundle identity to stamp (the chunk hash a crash stack names). Check that ' +
        'the bundler still emits a content-hashed entry chunk.',
    )
  }
  const stamp = webBuildStamp(indexHtml, now, sourceSha, packagedVersion)
  const versionStamped = injectProductVersionMeta(indexHtml, stamp.appVersion)
  const stamped = stamp.sourceSha
    ? injectSourceDigestMeta(versionStamped, stamp.sourceSha)
    : versionStamped
  writeFileSync(indexPath, stamped)
  refreshCompressedSiblings(indexPath, stamped)
  const stampBytes = `${JSON.stringify(stamp, null, 2)}\n`
  const manifest = clientBuildManifest(distDir, stamp, stampBytes, buildInvocation)
  writeFileSync(join(distDir, CLIENT_BUILD_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  // The stamp file stays LAST. Its digest is already in the manifest, so a reader
  // that sees podium-build.json sees a finished and exactly inventoried dist.
  writeFileSync(join(distDir, BUILD_STAMP_FILE), stampBytes)
  return stamp
}

function main(): void {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: write-web-build-stamp.ts <dist-dir>')
    process.exit(2)
  }
  const distDir = isAbsolute(arg) ? arg : resolve(process.cwd(), arg)

  const modelPath = resolvedModelPath()
  if (!modelPath?.startsWith(repoRoot)) {
    console.error(
      '[podium] build stamp: @podium/model resolved to ' +
        `${modelPath || '<unresolvable>'}, outside ${repoRoot}. ` +
        'This checkout has no local node_modules, so the stamp would fingerprint another ' +
        "checkout's schemas (POD-746). Run `bun install` here and rebuild.",
    )
    process.exit(1)
  }

  let stamp: WrittenBuildStamp
  try {
    stamp = writeWebBuildStamp(
      distDir,
      new Date(),
      resolveWebSourceSha(repoRoot),
      process.env.PODIUM_APP_VERSION,
      process.env.PODIUM_CLIENT_BUILD_INVOCATION,
    )
  } catch (err) {
    console.error(`[podium] build stamp: ${(err as Error).message}`)
    process.exit(1)
  }
  console.log(
    `[podium] build stamp: wire schema ${stamp.wireSchemaDigest}, ` +
      `version ${stamp.appVersion}` +
      `${stamp.bundleVersion ? `, bundle ${stamp.bundleVersion}` : ''}` +
      `${stamp.sourceSha ? `, source ${stamp.sourceSha}` : ''} → ${distDir}`,
  )
}

if (import.meta.main) main()
