/**
 * Headless release helper.
 *
 * Native build jobs run `--prepare-arch x64|arm64`, then one publisher job
 * downloads both prepared artifacts and runs `--publish-dir <dir>`. Keeping the
 * publish step singular avoids release/manifest races while ensuring the
 * embedded abduco helper is compiled on the architecture that will run it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export type HeadlessArch = 'x64' | 'arm64'

const HEADLESS_ARCH = {
  x64: {
    nodeArch: 'x64',
    target: 'linux-x86_64',
    asset: 'podium-headless-linux-x64.tar.gz',
  },
  arm64: {
    nodeArch: 'arm64',
    target: 'linux-aarch64',
    asset: 'podium-headless-linux-arm64.tar.gz',
  },
} as const satisfies Record<
  HeadlessArch,
  { nodeArch: NodeJS.Architecture; target: string; asset: string }
>

type PreparedHeadless = {
  version: string
  target: string
  asset: string
  signature: string
}

export function buildHeadlessManifestForPlatforms(p: {
  version: string
  platforms: Array<{ target: string; url: string; signature: string }>
}): string {
  return JSON.stringify(
    {
      version: p.version,
      platforms: Object.fromEntries(
        p.platforms.map(({ target, url, signature }) => [target, { url, signature }]),
      ),
    },
    null,
    2,
  )
}

/** Backward-compatible one-platform helper used by existing callers/tests. */
export function buildHeadlessManifest(p: {
  version: string
  url: string
  signature: string
  target?: string
}): string {
  return buildHeadlessManifestForPlatforms({
    version: p.version,
    platforms: [
      {
        target: p.target ?? 'linux-x86_64',
        url: p.url,
        signature: p.signature,
      },
    ],
  })
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function releaseUrl(channel: 'stable' | 'edge', tag: string, asset: string): string {
  return channel === 'stable'
    ? `https://github.com/madeinorbit/podium/releases/download/${tag}/${asset}`
    : `https://github.com/madeinorbit/podium/releases/download/edge/${asset}`
}

function descriptorName(asset: string): string {
  return `${asset}.json`
}

export function prepareHeadlessArchitecture(
  arch: HeadlessArch,
  outDir = 'dist-bun/release',
): PreparedHeadless {
  const config = HEADLESS_ARCH[arch]
  if (process.platform !== 'linux' || process.arch !== config.nodeArch) {
    throw new Error(
      `headless ${arch} must build natively on linux/${config.nodeArch}; ` +
        `this runner is ${process.platform}/${process.arch}`,
    )
  }

  execFileSync('bun', ['run', 'package:headless'], { stdio: 'inherit' })
  const version = readFileSync('dist-bun/headless/VERSION', 'utf8').trim()
  const built = `dist-bun/podium-headless-${version}.tar.gz`
  const builtSig = `${built}.sig`
  if (!existsSync(built) || !existsSync(builtSig)) {
    throw new Error(`headless build did not produce signed artifact ${built}`)
  }

  mkdirSync(outDir, { recursive: true })
  cpSync(built, join(outDir, config.asset))
  cpSync(builtSig, join(outDir, `${config.asset}.sig`))
  const prepared: PreparedHeadless = {
    version,
    target: config.target,
    asset: config.asset,
    signature: readFileSync(builtSig, 'utf8').trim(),
  }
  writeFileSync(join(outDir, descriptorName(config.asset)), `${JSON.stringify(prepared)}\n`)
  console.log(`[release] prepared ${config.target} → ${join(outDir, config.asset)}`)
  return prepared
}

export function loadPreparedHeadless(
  dir: string,
  requiredTargets: string[] = ['linux-x86_64', 'linux-aarch64'],
): { version: string; prepared: PreparedHeadless[] } {
  const prepared = readdirSync(dir)
    .filter((name) => name.endsWith('.tar.gz.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as PreparedHeadless)
    .sort((a, b) => a.target.localeCompare(b.target))
  if (prepared.length === 0) throw new Error(`no prepared headless artifacts in ${dir}`)

  const versions = new Set(prepared.map((item) => item.version))
  if (versions.size !== 1) throw new Error('prepared headless artifacts have different versions')
  for (const target of requiredTargets) {
    if (!prepared.some((item) => item.target === target)) {
      throw new Error(`prepared headless artifacts are missing ${target}`)
    }
  }
  if (new Set(prepared.map((item) => item.target)).size !== prepared.length) {
    throw new Error('prepared headless artifacts contain a duplicate platform target')
  }
  for (const item of prepared) {
    const asset = join(dir, item.asset)
    const signature = `${asset}.sig`
    if (!existsSync(asset) || !existsSync(signature)) {
      throw new Error(`prepared headless artifact is incomplete: ${item.asset}`)
    }
    if (readFileSync(signature, 'utf8').trim() !== item.signature) {
      throw new Error(`prepared headless signature descriptor drifted: ${item.asset}`)
    }
  }
  return { version: prepared[0]!.version, prepared }
}

function writeChecksums(dir: string, files: string[]): string {
  const output = files
    .map((file) => {
      const path = join(dir, file)
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      return `${digest}  ${basename(path)}`
    })
    .join('\n')
  const path = join(dir, 'SHA256SUMS')
  writeFileSync(path, `${output}\n`)
  return path
}

export function publishPreparedHeadless(p: {
  channel: 'stable' | 'edge'
  tag: string
  dir: string
  requiredTargets?: string[]
}): void {
  if (p.channel === 'stable' && !p.tag) throw new Error('stable release needs --tag vX.Y.Z')
  const { version, prepared } = loadPreparedHeadless(p.dir, p.requiredTargets)
  const manifestName = 'podium-update.json'
  writeFileSync(
    join(p.dir, manifestName),
    buildHeadlessManifestForPlatforms({
      version,
      platforms: prepared.map((item) => ({
        target: item.target,
        url: releaseUrl(p.channel, p.tag, item.asset),
        signature: item.signature,
      })),
    }),
  )
  writeFileSync(join(p.dir, 'VERSION'), `${version}\n`)
  const releaseFiles = [
    ...prepared.flatMap((item) => [item.asset, `${item.asset}.sig`]),
    manifestName,
    'VERSION',
  ]
  const checksums = writeChecksums(p.dir, releaseFiles)

  if (!process.env.GH_TOKEN) {
    console.log(`[release] built ${version} for ${p.channel}; set GH_TOKEN to publish.`)
    return
  }

  const assets = [...releaseFiles.map((file) => join(p.dir, file)), checksums, 'install.sh']
  if (p.channel === 'edge') {
    const releaseExists =
      spawnSync('gh', ['release', 'view', 'edge'], { stdio: 'ignore' }).status === 0
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
    execFileSync('gh', ['release', 'create', p.tag, '--latest', '--generate-notes', ...assets])
  }
  console.log(`[release] published ${version} → ${p.channel}`)
}

async function main(): Promise<void> {
  const channel = (arg('--channel') ?? 'edge') as 'stable' | 'edge'
  if (channel !== 'stable' && channel !== 'edge') throw new Error(`unknown channel ${channel}`)
  const tag = channel === 'stable' ? (arg('--tag') ?? '') : 'edge'
  const prepareArch = arg('--prepare-arch')
  const publishDir = arg('--publish-dir')
  if (prepareArch && publishDir) throw new Error('choose --prepare-arch or --publish-dir')

  if (prepareArch) {
    if (prepareArch !== 'x64' && prepareArch !== 'arm64') {
      throw new Error(`unknown headless architecture ${prepareArch}`)
    }
    prepareHeadlessArchitecture(prepareArch)
    return
  }
  if (publishDir) {
    publishPreparedHeadless({ channel, tag, dir: publishDir })
    return
  }

  // Local build convenience: prepare only the native architecture and emit a
  // local single-platform manifest. Publishing is intentionally reserved for the
  // matrix workflow, which supplies both supported Linux targets atomically.
  if (process.env.GH_TOKEN) {
    throw new Error('publishing requires the multi-architecture --publish-dir workflow')
  }
  const nativeArch: HeadlessArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const prepared = prepareHeadlessArchitecture(nativeArch)
  publishPreparedHeadless({
    channel,
    tag,
    dir: 'dist-bun/release',
    requiredTargets: [prepared.target],
  })
}

if (import.meta.main) void main()
