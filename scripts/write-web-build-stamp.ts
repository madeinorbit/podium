/**
 * STAMP A BUILT WEB DIST WITH THE SCHEMA IT CONTAINS (POD-1610) AND THE SOURCE
 * IT WAS BUILT FROM.
 *
 * Writes `podium-build.json` beside index.html, carrying:
 * - `wireSchemaDigest()` — protocol compatibility
 * - `appVersion` — `bundle+<entry chunk hash>` for log records (POD-1965)
 * - `sourceSha` — `git rev-parse --short=7 HEAD`, install identity for Update
 *
 * The Update panel compares `sourceSha` to the published `artifacts.web.digest`.
 * `wireSchemaDigest` is not that identity — UI-only commits keep the same
 * protocol digest. `appVersion` is not that identity either — it names the
 * emitted bundle for logs, not the checkout.
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

/**
 * The stamp a built `index.html` earns. Pure, and exported, so the contract the
 * page depends on can be asserted without a build (and without spawning this
 * script, which a worktree with no `node_modules` cannot do — the POD-746 guard
 * below fires first).
 *
 * THROWS when the html carries no hashed module entry, and that is the important
 * half. A built dist always has one, so its absence means the assumption this
 * derivation rests on has moved — a vite config change, a different bundler —
 * and the right answer is to fail the build. Writing a stamp without
 * `appVersion` is precisely the silent absence POD-1965 is about: every record
 * would ship unversioned again and nothing would say so.
 *
 * `sourceSha` is optional and separate: install identity for Update, not the
 * log `v`. Omit it when git cannot name HEAD.
 */
export function webBuildStamp(
  indexHtml: string,
  now: Date = new Date(),
  sourceSha?: string,
): WrittenBuildStamp {
  const appVersion = bundleVersionFromHtml(indexHtml)
  if (!appVersion) {
    throw new Error(
      'no hashed module entry script in index.html, so this build has no identity to stamp ' +
        'its log records with (POD-1965). Check that vite still emits a content-hashed entry chunk.',
    )
  }
  return {
    wireSchemaDigest: wireSchemaDigest(),
    wireVersion: WIRE_VERSION,
    builtAt: now.toISOString(),
    appVersion,
    ...(sourceSha ? { sourceSha } : {}),
  }
}

function main(): void {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: write-web-build-stamp.ts <dist-dir>')
    process.exit(2)
  }
  const distDir = isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
  const indexPath = join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    console.error(`[podium] build stamp: ${distDir} has no index.html — did vite build run?`)
    process.exit(1)
  }

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

  // WHICH BUILD, for every log record this bundle writes (POD-1965). Derived
  // from the emitted index.html by the same function the page itself calls, so
  // the stamp and the running page cannot name the build differently — they did
  // for as long as this file wrote keys the reader never looked for.
  let stamp: WrittenBuildStamp
  try {
    stamp = webBuildStamp(
      readFileSync(indexPath, 'utf8'),
      new Date(),
      resolveWebSourceSha(repoRoot),
    )
  } catch (err) {
    console.error(`[podium] build stamp: ${indexPath}: ${(err as Error).message}`)
    process.exit(1)
  }
  writeFileSync(join(distDir, BUILD_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
  console.log(
    `[podium] build stamp: wire schema ${stamp.wireSchemaDigest}, ` +
      `build ${stamp.appVersion}` +
      `${stamp.sourceSha ? `, source ${stamp.sourceSha}` : ''} → ${distDir}`,
  )
}

if (import.meta.main) main()
