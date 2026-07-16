/**
 * Release helper: build the signed headless bundle, emit the channel manifest, and (when
 * GH_TOKEN + a target are set) publish to a GitHub release via `gh`. Callable locally:
 *   bun scripts/release.ts --channel edge        # build + upload to the rolling edge prerelease
 *   bun scripts/release.ts --channel stable --tag v0.2.0
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export function buildHeadlessManifest(p: {
  version: string
  url: string
  signature: string
  /** Manifest platform-asset key (Tauri target prefix); the headless CI builds linux-x64. */
  target?: string
}): string {
  const target = p.target ?? 'linux-x86_64'
  return JSON.stringify(
    { version: p.version, platforms: { [target]: { url: p.url, signature: p.signature } } },
    null,
    2,
  )
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const channel = (arg('--channel') ?? 'edge') as 'stable' | 'edge'
  const tag = channel === 'stable' ? (arg('--tag') ?? '') : 'edge'
  if (channel === 'stable' && !tag) throw new Error('stable release needs --tag vX.Y.Z')

  // 1) build + sign the headless bundle (writes dist-bun/headless/* + the tarball + .sig)
  execFileSync('bun', ['run', 'package:headless'], { stdio: 'inherit' })
  const version = readFileSync('dist-bun/headless/VERSION', 'utf8').trim()
  const tarball = `podium-headless-linux-x64.tar.gz` // build-bun emits a versioned name; rename for a stable URL
  execFileSync('bash', ['-c', `cp dist-bun/podium-headless-*.tar.gz dist-bun/${tarball}`])
  execFileSync('bash', ['-c', `cp dist-bun/podium-headless-*.tar.gz.sig dist-bun/${tarball}.sig`])
  const sig = readFileSync(`dist-bun/${tarball}.sig`, 'utf8').trim()

  const url =
    channel === 'stable'
      ? `https://github.com/madeinorbit/podium/releases/download/${tag}/${tarball}`
      : `https://github.com/madeinorbit/podium/releases/download/edge/${tarball}`
  writeFileSync(
    'dist-bun/podium-update.json',
    buildHeadlessManifest({ version, url, signature: sig }),
  )
  writeFileSync('dist-bun/VERSION', version)

  // SHA256SUMS over every published artifact so users can verify downloads without gh
  // (README documents: sha256sum -c SHA256SUMS --ignore-missing). [spec:SP-7f2c]
  execFileSync('bash', [
    '-c',
    `cd dist-bun && sha256sum ${tarball} ${tarball}.sig podium-update.json VERSION > SHA256SUMS`,
  ])

  if (!process.env.GH_TOKEN) {
    console.log(`[release] built ${version} for ${channel}; set GH_TOKEN to publish.`)
    return
  }
  // 2) publish via gh. Edge updates only its headless assets in place: deleting the release
  // would erase an explicitly promoted desktop build on every main push. [spec:SP-7f2c]
  const assets = [
    `dist-bun/${tarball}`,
    `dist-bun/${tarball}.sig`,
    'dist-bun/podium-update.json',
    'dist-bun/VERSION',
    'dist-bun/SHA256SUMS',
    'install.sh',
  ]
  if (channel === 'edge') {
    const releaseExists =
      spawnSync('gh', ['release', 'view', 'edge'], {
        stdio: 'ignore',
      }).status === 0
    const sha =
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (releaseExists) {
      const repo = process.env.GITHUB_REPOSITORY ?? 'madeinorbit/podium'
      execFileSync('gh', [
        'api',
        '--method',
        'PATCH',
        `repos/${repo}/git/refs/tags/edge`,
        '-f',
        `sha=${sha}`,
        '-F',
        'force=true',
      ])
      execFileSync('gh', [
        'release',
        'edit',
        'edge',
        '--prerelease',
        '--title',
        `edge (${version})`,
        '--notes',
        `Rolling edge build ${version}`,
      ])
      execFileSync('gh', ['release', 'upload', 'edge', ...assets, '--clobber'])
    } else {
      execFileSync('gh', [
        'release',
        'create',
        'edge',
        '--target',
        sha,
        '--prerelease',
        '--title',
        `edge (${version})`,
        '--notes',
        `Rolling edge build ${version}`,
        ...assets,
      ])
    }
  } else {
    execFileSync('gh', ['release', 'create', tag, '--latest', '--generate-notes', ...assets])
    // Desktop promotion is a separate workflow_dispatch operation. [spec:SP-7f2c]
  }
  console.log(`[release] published ${version} → ${channel}`)
}

if (import.meta.main) void main()
