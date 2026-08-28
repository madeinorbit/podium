/**
 * The release gate must refuse a bundle that only has the spike layout.
 *
 * assert-headless-bundle.sh used to require podium-cli, the launcher, VERSION, and
 * any file named index.html — exactly what POD-2501's spike packed. A production
 * bundle from scripts/build-bun.ts also carries systemd/, LICENSE, NOTICE,
 * THIRD-PARTY-NOTICES.md, and stamped client sites. These tests pack a fake
 * production-shaped tree (tiny, not a real binary) and prove the layout checks
 * fire for the right reason, before the 20 MB Mach-O / ELF checks. The Darwin
 * entitlement refusal is proven against a real tarball by
 * scripts/prove-headless-assertions-can-fail.sh (empty entitlements case).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNoCallerSuppliedClientRootDigest,
  clientBuildRootDigest,
} from './client-build-root-digest'
import {
  beginFreshClientPackagingSession,
  packageHeadlessForFreshClients,
  type FreshClientPackagingSession,
} from './build-bun'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const JIT_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-library-validation',
] as const

const TEST_VERSION = '0.0.0-test'
const TEST_SOURCE_SHA = '012345a'
const WEB_HASH = 'AbCdEf12'
const MOBILE_HASH = '0123456789abcdef0123456789abcdef'

// Reviewer-grade generated noise: it defeated the former size/compression plausibility
// checks, but changing even one byte now violates the build-produced manifest.
const CLIENT_ENTRY = Array.from({ length: 3_000 }, (_, index) => {
  const value = createHash('sha256').update(String(index)).digest('hex')
  return `const value_${index}=()=>({index:${index},value:"${value}"});`
}).join('\n')

function productionHtml(site: 'web' | 'mobile'): string {
  const src =
    site === 'web'
      ? `/assets/index-${WEB_HASH}.js`
      : `/mobile/_expo/static/js/web/entry-${MOBILE_HASH}.js`
  const type = site === 'web' ? ' type="module"' : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="podium-version" content="${TEST_VERSION}" />
    <title>Podium</title>
  </head>
  <body>
    <div id="root"></div>
    <script${type} src="${src}"></script>
  </body>
</html>
`
}

function productionStamp(hash: string): Record<string, string | number> {
  return {
    wireSchemaDigest: '0123456789abcdef',
    wireVersion: 1,
    appVersion: TEST_VERSION,
    sourceSha: TEST_SOURCE_SHA,
    bundleVersion: `bundle+${hash}`,
  }
}

function writeBuildManifest(siteDir: string, stamp: Record<string, string | number>): void {
  const files: Record<string, string> = {}
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === 'podium-build-manifest.json') continue
      if (entry.isDirectory()) visit(path)
      else {
        const name = relative(siteDir, path).split(sep).join('/')
        files[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  visit(siteDir)
  writeFileSync(
    join(siteDir, 'podium-build-manifest.json'),
    `${JSON.stringify(
      {
        manifestVersion: 2,
        sourceCommit: TEST_SOURCE_SHA,
        buildStamp: stamp,
        fileCount: Object.keys(files).length,
        files,
      },
      null,
      2,
    )}\n`,
  )
}

const SPIKE_STUB = '<!doctype html><title>spike</title><p>POD-2501 spike — no web dist</p>\n'

const UNIT = `[Unit]
Description=Podium test unit
[Service]
ExecStart=/bin/true
`

const made: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-assert-layout-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeProductionTree(headless: string): string {
  mkdirSync(join(headless, 'web'), { recursive: true })
  mkdirSync(join(headless, 'mobile'), { recursive: true })
  mkdirSync(join(headless, 'systemd'), { recursive: true })
  writeFileSync(join(headless, 'podium-cli'), '#!/bin/sh\necho stub-cli\n')
  chmodSync(join(headless, 'podium-cli'), 0o755)
  writeFileSync(
    join(headless, 'podium'),
    '#!/bin/sh\nexport PODIUM_HOME="$DIR"\nexec "$DIR/podium-cli" "$@"\n',
  )
  chmodSync(join(headless, 'podium'), 0o755)
  writeFileSync(join(headless, 'VERSION'), `${TEST_VERSION}\n`)
  writeFileSync(join(headless, 'LICENSE'), 'Apache License Version 2.0\n')
  writeFileSync(join(headless, 'NOTICE'), 'Podium\n')
  writeFileSync(join(headless, 'THIRD-PARTY-NOTICES.md'), '# Third-party notices\n')
  for (const site of ['web', 'mobile'] as const) {
    const hash = site === 'web' ? WEB_HASH : MOBILE_HASH
    const entry =
      site === 'web'
        ? join(headless, site, 'assets', `index-${hash}.js`)
        : join(headless, site, '_expo', 'static', 'js', 'web', `entry-${hash}.js`)
    mkdirSync(dirname(entry), { recursive: true })
    const stamp = productionStamp(hash)
    writeFileSync(join(headless, site, 'index.html'), productionHtml(site))
    writeFileSync(join(headless, site, 'podium-build.json'), `${JSON.stringify(stamp, null, 2)}\n`)
    writeFileSync(entry, CLIENT_ENTRY)
    writeFileSync(join(headless, site, 'Alpha.txt'), 'capital sorts before punctuation\n')
    writeFileSync(join(headless, site, '_metadata.txt'), 'punctuation sorts before lowercase\n')
    writeBuildManifest(join(headless, site), stamp)
  }
  writeFileSync(join(headless, 'systemd', 'podium.service'), UNIT)
  return clientBuildRootDigest(headless)
}

function pack(headlessParent: string): string {
  const tarball = join(headlessParent, 'bundle.tar.gz')
  execFileSync('tar', ['-czf', tarball, '-C', headlessParent, 'headless'])
  return tarball
}

function runGate(tarball: string): {
  status: number
  failLine: string
  output: string
} {
  const result = spawnSync(
    'bash',
    [
      'scripts/assert-headless-bundle.sh',
      tarball,
      'linux-x86_64',
      '--source-commit',
      TEST_SOURCE_SHA,
      '--no-abduco-identity',
    ],
    { encoding: 'utf8', cwd: repoRoot },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const failLine =
    output
      .split('\n')
      .find((line) => /^(FAIL|ABORT):/.test(line))
      ?.trim() ?? ''
  return { status: result.status ?? 1, failLine, output }
}

describe('assert-headless-bundle production layout', () => {
  it('refuses an empty client inventory consistently with the shipped-bytes verifier', () => {
    const clients = scratch()
    for (const site of ['web', 'mobile']) {
      mkdirSync(join(clients, site), { recursive: true })
      writeFileSync(
        join(clients, site, 'podium-build-manifest.json'),
        '{"manifestVersion":1,"files":{}}\n',
      )
    }
    expect(() => clientBuildRootDigest(clients)).toThrow(/has no v2 file inventory/)
  })

  it('refuses a bundle with systemd/ removed', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    rmSync(join(headless, 'systemd'), { recursive: true, force: true })
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/tarball missing headless\/systemd/)
  })

  it('refuses a mutated spike stub because it is not the manifested build output', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    writeFileSync(join(headless, 'web', 'index.html'), SPIKE_STUB)
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/build provenance hash mismatch for index\.html/)
  })

  it('refuses the padded, coherently stamped forged web dist that defeated plausibility checks', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    writeFileSync(
      join(headless, 'web', 'index.html'),
      `${productionHtml('web')}<!-- forged padding ${'x'.repeat(200_000)} -->\n`,
    )
    rmSync(join(headless, 'web', 'assets'), { recursive: true, force: true })
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/build provenance file set mismatch/)
  })

  it('refuses a forged session even when its digest matches fabricated bytes perfectly', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    const web = join(headless, 'web')
    writeFileSync(
      join(web, 'index.html'),
      `${productionHtml('web')}<!-- forged padding ${'x'.repeat(200_000)} -->\n`,
    )
    rmSync(join(web, 'assets'), { recursive: true, force: true })
    const forgedStamp = productionStamp(WEB_HASH)
    writeFileSync(join(web, 'podium-build.json'), `${JSON.stringify(forgedStamp, null, 2)}\n`)
    writeBuildManifest(web, forgedStamp)

    const attackerSession = Object.freeze({
      clientRootDigest: clientBuildRootDigest(headless),
      version: TEST_VERSION,
    }) as FreshClientPackagingSession
    expect(() => packageHeadlessForFreshClients(attackerSession, [])).toThrow(
      /requires client build evidence minted by this invocation/,
    )
  })

  it('refuses to mint a session when PATH replaces the running Bun with a no-op', async () => {
    const fakeBin = scratch()
    const fakeBun = join(fakeBin, process.platform === 'win32' ? 'bun.exe' : 'bun')
    writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeBun, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
    try {
      // REJECTS, not throws: the session became async when the client build moved
      // behind the Turbo lane (POD-3053). A `.toThrow()` on an async function passes
      // for the wrong reason — nothing is thrown synchronously — so this guard would
      // have gone green against a build that had stopped refusing entirely.
      await expect(beginFreshClientPackagingSession([])).rejects.toThrow(
        /PATH resolves bun to .* not the running interpreter/,
      )
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('refuses the reviewer attack that passes a no-op PATH as a second argument', async () => {
    await expect(
      (
        beginFreshClientPackagingSession as unknown as (
          argv: readonly string[],
          env: NodeJS.ProcessEnv,
        ) => Promise<FreshClientPackagingSession>
      )([], { ...process.env, PATH: '/tmp/pod2540-noop-bun' }),
    ).rejects.toThrow(/caller-supplied environment is forbidden for client freshness/)
  })

  it('packaging accepts only evidence minted by verifyClientBuild', () => {
    const forged = {
      clientRootDigest: 'a'.repeat(64),
      version: TEST_VERSION,
      sourceCommit: TEST_SOURCE_SHA,
      sites: { web: '/x', mobile: '/y' },
    }
    expect(() => packageHeadlessForFreshClients(forged as never, [])).toThrow(
      /requires client build evidence minted by this invocation/,
    )
  })

  it('refuses an attacker-computed digest supplied through the old shell interface', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    const web = join(headless, 'web')
    writeFileSync(
      join(web, 'index.html'),
      `${productionHtml('web')}<!-- forged padding ${'x'.repeat(200_000)} -->\n`,
    )
    rmSync(join(web, 'assets'), { recursive: true, force: true })
    const forgedStamp = productionStamp(WEB_HASH)
    writeFileSync(join(web, 'podium-build.json'), `${JSON.stringify(forgedStamp, null, 2)}\n`)
    writeBuildManifest(web, forgedStamp)
    const attackerDigest = clientBuildRootDigest(headless)
    const result = spawnSync(
      'bash',
      [
        'scripts/assert-headless-bundle.sh',
        pack(root),
        'linux-x86_64',
        '--source-commit',
        TEST_SOURCE_SHA,
        '--client-root-digest',
        attackerDigest,
        '--no-abduco-identity',
      ],
      { encoding: 'utf8', cwd: repoRoot },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).not.toBe(0)
    expect(output).toMatch(/unknown flag --client-root-digest/)
  })

  it('refuses caller-supplied digests through both production entry-point spellings', () => {
    expect(() =>
      assertNoCallerSuppliedClientRootDigest(
        ['--prepare-cross', `--client-root-digest=${'a'.repeat(64)}`],
        {},
      ),
    ).toThrow(/--client-root-digest is forbidden/)
    expect(() =>
      assertNoCallerSuppliedClientRootDigest([], {
        PODIUM_EXPECTED_CLIENT_ROOT_DIGEST: 'a'.repeat(64),
      }),
    ).toThrow(/PODIUM_EXPECTED_CLIENT_ROOT_DIGEST is forbidden/)

    const releaseCli = spawnSync(
      'bun',
      ['scripts/release.ts', '--prepare-cross', '--client-root-digest', 'a'.repeat(64)],
      { encoding: 'utf8', cwd: repoRoot },
    )
    expect(releaseCli.status).not.toBe(0)
    expect(`${releaseCli.stdout ?? ''}${releaseCli.stderr ?? ''}`).toMatch(
      /--client-root-digest is forbidden/,
    )

    const packageCli = spawnSync(
      'bun',
      ['scripts/package-headless.ts', `--client-root-digest=${'a'.repeat(64)}`],
      { encoding: 'utf8', cwd: repoRoot },
    )
    expect(packageCli.status).not.toBe(0)
    expect(`${packageCli.stdout ?? ''}${packageCli.stderr ?? ''}`).toMatch(
      /--client-root-digest is forbidden/,
    )

    const buildCli = spawnSync('bun', ['scripts/build-bun.ts'], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PODIUM_EXPECTED_CLIENT_ROOT_DIGEST: 'a'.repeat(64),
      },
    })
    expect(buildCli.status).not.toBe(0)
    expect(`${buildCli.stdout ?? ''}${buildCli.stderr ?? ''}`).toMatch(
      /PODIUM_EXPECTED_CLIENT_ROOT_DIGEST is forbidden/,
    )

    const noProofBuildCli = spawnSync('bun', ['scripts/build-bun.ts'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    expect(noProofBuildCli.status).not.toBe(0)
    expect(`${noProofBuildCli.stdout ?? ''}${noProofBuildCli.stderr ?? ''}`).toMatch(
      /direct headless packaging is forbidden/,
    )
  })

  it('refuses generated noise plus inert code even when it looks like a client asset', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    writeFileSync(
      join(headless, 'web', 'assets', `index-${WEB_HASH}.js`),
      `${CLIENT_ENTRY}\nfunction inert(){return 1}\n${'/* plausible noise */\n'.repeat(10_000)}`,
    )
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/build provenance hash mismatch for assets\/index-.*\.js/)
  })

  it('refuses the same coherently stamped fabrication in the mobile client', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    writeFileSync(
      join(headless, 'mobile', 'index.html'),
      `${productionHtml('mobile')}<!-- forged padding ${'x'.repeat(200_000)} -->\n`,
    )
    rmSync(join(headless, 'mobile', '_expo'), { recursive: true, force: true })
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/build provenance file set mismatch/)
  })

  it('refuses a production-shaped client when its build manifest is absent', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    rmSync(join(headless, 'web', 'podium-build-manifest.json'))
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/has no build provenance manifest/)
  })

  it('refuses manifested clients from a commit other than the release commit', () => {
    const root = scratch()
    writeProductionTree(join(root, 'headless'))
    const tarball = pack(root)
    const result = spawnSync(
      'bash',
      [
        'scripts/assert-headless-bundle.sh',
        tarball,
        'linux-x86_64',
        '--source-commit',
        'fffffff',
        '--no-abduco-identity',
      ],
      { encoding: 'utf8', cwd: repoRoot },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).not.toBe(0)
    expect(output).toMatch(/build provenance source commit .* does not match release commit/)
  })

  it('refuses a bundle with NOTICE missing', () => {
    const root = scratch()
    const headless = join(root, 'headless')
    writeProductionTree(headless)
    rmSync(join(headless, 'NOTICE'))
    const { status, failLine } = runGate(pack(root))
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/tarball missing headless\/NOTICE/)
  })

  it('lets a complete production layout through to the binary checks', () => {
    // A tiny podium-cli cannot be a shipped Bun runtime. Reaching THAT failure
    // is the proof the layout checks accepted the tree — a gate that rejected
    // everything would never get here.
    const root = scratch()
    writeProductionTree(join(root, 'headless'))
    const tarball = pack(root)
    const { status, failLine } = runGate(tarball)
    expect(status).not.toBe(0)
    expect(failLine).toMatch(/shipped podium-cli/)
    expect(failLine).not.toMatch(/tarball missing|NOTICE|systemd|build provenance|build stamp/)
  })
})

describe('the gate and the signing step name the same JIT keys', () => {
  it('asserts every entitlement key the plist attaches', () => {
    const gate = readFileSync(join(repoRoot, 'scripts/assert-headless-bundle.sh'), 'utf8')
    const plist = readFileSync(join(repoRoot, 'scripts/bun-jit.entitlements.plist'), 'utf8')
    for (const key of JIT_ENTITLEMENTS) {
      expect(plist).toContain(`<key>${key}</key>`)
      expect(gate).toContain(key)
    }
    expect(gate).toContain('rcodesign CONTRIBUTES THE ENTITLEMENTS, NOT THE SIGNATURE')
  })

  it('keeps the empty-entitlements refusal in the release-job proof harness', () => {
    const prove = readFileSync(
      join(repoRoot, 'scripts/prove-headless-assertions-can-fail.sh'),
      'utf8',
    )
    expect(prove).toContain('entitlements missing com.apple.security.cs.allow-jit')
    expect(prove).toContain('empty entitlements')
    expect(prove).toContain('all JIT entitlements false')
    expect(prove).toContain('systemd/ removed')
    expect(prove).toContain('stub web/index.html')
    expect(prove).toContain('padded forged web stub with matching forged manifest')
    expect(prove).toContain('web build provenance manifest removed')
    expect(prove).toContain('NOTICE missing')
  })

  it('says in the release job that rcodesign supplies entitlements, not the signature', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('does not add the Darwin signature')
    expect(workflow).toContain('five Bun JIT entitlement keys')
    expect(workflow).toContain('what breaks is JIT, at runtime')
    expect(workflow).toContain('scripts/assert-headless-bundle.sh')
    expect(workflow).toContain('--source-commit "$GITHUB_SHA"')
    expect(workflow).not.toContain('--client-root-digest')
    expect(workflow).toContain('scripts/prove-headless-assertions-can-fail.sh')
  })

  it('keeps fresh-build session branding wired into every production packaging path', () => {
    const release = readFileSync(join(repoRoot, 'scripts/release.ts'), 'utf8')
    const buildBun = readFileSync(join(repoRoot, 'scripts/build-bun.ts'), 'utf8')
    const packageHeadless = readFileSync(join(repoRoot, 'scripts/package-headless.ts'), 'utf8')
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8')
    const windowsSmoke = readFileSync(join(repoRoot, '.github/workflows/windows-smoke.yml'), 'utf8')
    expect(release).toContain('const session = await beginFreshClientPackagingSession([])')
    expect(release).toContain('packageHeadlessForFreshClients(')
    expect(buildBun).toContain('isClientBuildEvidence(session)')
    expect(buildBun).toContain('await buildClients(root')
    expect(buildBun).not.toContain('package:clients')
    expect(buildBun).toContain('verifyClientBuild({')
    expect(buildBun).not.toContain('PODIUM_CLIENT_BUILD_INVOCATION')
    expect(buildBun).toContain('direct headless packaging is forbidden')
    expect(buildBun).toContain('continuity, not correctness')
    expect(packageHeadless).toContain('beginFreshClientPackagingSession(argv)')
    expect(packageHeadless).toContain('packageHeadlessForFreshClients(session, argv)')
    expect(packageJson).toContain('"package:headless": "bun scripts/package-headless.ts"')
    // Each client has exactly one production build script, and it is a Turbo task
    // (spec §4.1). No root script chains them; `package:clients` is gone.
    const web = JSON.parse(readFileSync(join(repoRoot, 'apps/web/package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>
    }
    const mobile = JSON.parse(readFileSync(join(repoRoot, 'apps/mobile/package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>
    }
    expect(web.scripts.build).toBe(
      'vite build && bun ../../scripts/archive-web-sourcemaps.ts dist && bun ../../scripts/precompress-dist.ts dist && bun --conditions=@podium/source ../../scripts/write-web-build-stamp.ts dist && bun ../../scripts/web-bundle-budget.ts dist --check',
    )
    expect(web.scripts['build:dist']).toBeUndefined()
    expect(mobile.scripts.build).toBe(
      'expo export -p web && bun scripts/patch-web-html.ts && bun ../../scripts/precompress-dist.ts dist && bun --conditions=@podium/source ../../scripts/write-web-build-stamp.ts dist',
    )
    expect(mobile.scripts['build:web']).toBeUndefined()
    expect(packageJson).not.toContain('package:clients')
    expect(packageJson).toContain('"build": "bun scripts/build-clients.ts --workspace"')
    expect(packageJson).toContain('"build:clients": "bun scripts/build-clients.ts"')
    expect(windowsSmoke).not.toContain('bun scripts/build-bun.ts')
    // LAST on purpose (POD-3058): this expectation is red — windows-smoke.yml has no
    // such step — and an early failure in a single `it` makes every assertion after it
    // unreachable, so a red here silently stopped guarding everything below. Fixing it
    // belongs to POD-3058; keeping it at the end is what stops it hiding the rest.
    expect(windowsSmoke).toContain('run: bun run package:headless')
  })
})
