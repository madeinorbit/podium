/**
 * STAMP A BUILT WEB DIST WITH THE SCHEMA IT CONTAINS (POD-1610) AND THE
 * PRODUCT VERSION OPERATORS SEE.
 *
 * Writes `podium-build.json` beside index.html, carrying:
 * - `wireSchemaDigest()` — protocol compatibility
 * - `appVersion` — product version: `PODIUM_APP_VERSION` or `dev+<sourceSha>`
 * - `sourceSha` — `git rev-parse --short=7 HEAD`, `artifacts.web.digest`
 * - `bundleVersion` — `bundle+<entry chunk hash>`, forensic only
 *
 * The Update panel, About, `/version`, and log field `v` all read `appVersion`.
 * `wireSchemaDigest` is not that identity — UI-only commits keep the same
 * protocol digest. `bundleVersion` is not that identity either — it names
 * the emitted chunk a crash stack already prints.
 *
 * Also writes the product version into `<meta name="podium-version">` so the
 * running page can read the same string synchronously (About and web logs)
 * without fetching the stamp and without treating the chunk hash as `v`.
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILD_STAMP_FILE,
  type BuildStamp,
  bundleVersionFromHtml,
  PRODUCT_VERSION_META,
  resolveProductVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '../packages/protocol/src/index'
import { developmentSourceSha } from '../packages/runtime/src/source-version'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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

export function writeWebBuildStamp(
  distDir: string,
  now: Date = new Date(),
  sourceSha?: string,
  packagedVersion?: string,
): WrittenBuildStamp {
  const indexPath = join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`${distDir} has no index.html — did vite build run?`)
  }
  const indexHtml = readFileSync(indexPath, 'utf8')
  if (!bundleVersionFromHtml(indexHtml)) {
    throw new Error(
      'no hashed module entry script in index.html, so this build has no forensic ' +
        'bundle identity to stamp (the chunk hash a crash stack names). Check that ' +
        'vite still emits a content-hashed entry chunk.',
    )
  }
  const stamp = webBuildStamp(indexHtml, now, sourceSha, packagedVersion)
  writeFileSync(indexPath, injectProductVersionMeta(indexHtml, stamp.appVersion))
  writeFileSync(join(distDir, BUILD_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
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
