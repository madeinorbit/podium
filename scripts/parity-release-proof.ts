/**
 * Fail-closed release evidence for the shared clients, native iOS, and packaged
 * desktop applications. This command never builds, submits, publishes, or starts
 * a paid service. It validates the contract and the evidence gathered by the
 * platform-specific procedures in docs/parity-release-proof.md.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

export const PROOF_SCHEMA_VERSION = 1
export const IOS_DEPLOYMENT_TARGET = '16.4'
export const CURRENT_IOS_VERSION = '26.6.1'
export const CURRENT_MACOS_VERSION = 'macOS 26.6.2'

export type EvidenceSource =
  | 'automated'
  | 'simulator'
  | 'physical-device'
  | 'packaged-desktop'
  | 'unavailable'

export type EvidenceStatus = 'passed' | 'failed' | 'unavailable'

export type ProofCheck = {
  id: string
  title: string
  source: Exclude<EvidenceSource, 'unavailable'>
  platform: 'shared' | 'ios' | 'macos' | 'windows' | 'linux'
  owner: string
  command?: string
  deviceRequired?: boolean
  expectedDevice?: string
  expectedOsVersion?: string
  expectedPackage?: RegExp
  expectedPackageDescription?: string
  covers: string[]
}

export const PROOF_CHECKS: ProofCheck[] = [
  {
    id: 'shared-client-contracts',
    title: 'Shared client contracts',
    source: 'automated',
    platform: 'shared',
    owner: 'parity-release-proof',
    command: 'bun run test:cached',
    covers: [
      'shared models, commands, and client projections',
      'web and Expo component semantics',
      'the owned mobile-browser compatibility suites, which are never native proof',
    ],
  },
  {
    id: 'ios-minimum-simulator-smoke',
    title: 'Minimum iOS simulator smoke',
    source: 'simulator',
    platform: 'ios',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'iPhone SE (3rd generation)',
    expectedOsVersion: '16.4',
    covers: [
      'cold launch and foreground resume',
      'navigation, keyboard, gestures, permissions, persistence, and offline replay',
      'native accessibility labels, states, focus order, Dynamic Type, and Reduce Motion',
    ],
  },
  {
    id: 'ios-current-simulator-smoke',
    title: 'Current iOS simulator smoke',
    source: 'simulator',
    platform: 'ios',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'iPhone 16 Pro',
    expectedOsVersion: CURRENT_IOS_VERSION,
    covers: [
      'current stable iOS navigation and system chrome',
      'current permission, keyboard, accessibility, and lifecycle behavior',
    ],
  },
  {
    id: 'ios-minimum-device',
    title: 'Minimum iPhone release check',
    source: 'physical-device',
    platform: 'ios',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'iPhone SE (2nd generation)',
    expectedOsVersion: '16.4',
    covers: [
      'iPhone SE (2nd generation) on iOS 16.4',
      'install, cold launch, storage, background reclaim, keyboard, and VoiceOver',
      'the expected unavailable speech experience before its native OS requirement',
    ],
  },
  {
    id: 'ios-current-device',
    title: 'Current iPhone release check',
    source: 'physical-device',
    platform: 'ios',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'iPhone 16 Pro',
    expectedOsVersion: CURRENT_IOS_VERSION,
    covers: [
      'iPhone 16 Pro on the current stable iOS release',
      'TestFlight install, safe areas, microphone, speech, haptics, and VoiceOver',
      'Wi-Fi and cellular handoff plus terminated notification entry',
    ],
  },
  {
    id: 'ios-native-performance-floor',
    title: 'Native iOS performance floor',
    source: 'physical-device',
    platform: 'ios',
    owner: 'POD-1767',
    deviceRequired: true,
    expectedDevice: 'iPhone SE (2nd generation)',
    expectedOsVersion: '16.4',
    covers: [
      'the minimum-device release-build launch, transcript, scroll, resume, and memory baseline',
      'imported evidence only; this program does not run a competing native benchmark',
    ],
  },
  {
    id: 'ios-native-performance-promotion',
    title: 'Native iOS ProMotion performance',
    source: 'physical-device',
    platform: 'ios',
    owner: 'POD-1767',
    deviceRequired: true,
    expectedDevice: 'iPhone 16 Pro',
    expectedOsVersion: CURRENT_IOS_VERSION,
    covers: [
      'the current ProMotion-device release-build frame pacing and interaction baseline',
      'imported evidence only; this program does not run a competing native benchmark',
    ],
  },
  {
    id: 'desktop-macos-apple-silicon-package',
    title: 'Apple Silicon macOS acceptance',
    source: 'packaged-desktop',
    platform: 'macos',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'MacBook Pro (14-inch, M4 Pro, 2024)',
    expectedOsVersion: CURRENT_MACOS_VERSION,
    expectedPackage: /^Podium_.+_aarch64\.dmg$/,
    expectedPackageDescription: 'Podium_<version>_aarch64.dmg',
    covers: [
      'Apple Silicon signed, notarized, stapled DMG',
      'fresh install, launch, native chrome, opener, file dialog, clipboard, and updater restart',
      'VoiceOver and keyboard traversal on the packaged application',
    ],
  },
  {
    id: 'desktop-macos-intel-package',
    title: 'Intel macOS acceptance',
    source: 'packaged-desktop',
    platform: 'macos',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'MacBook Pro (16-inch, 2019, Intel)',
    expectedOsVersion: CURRENT_MACOS_VERSION,
    expectedPackage: /^Podium_.+_x64\.dmg$/,
    expectedPackageDescription: 'Podium_<version>_x64.dmg',
    covers: [
      'Intel signed, notarized, stapled DMG',
      'fresh install, launch, native chrome, opener, file dialog, clipboard, and updater restart',
      'VoiceOver and keyboard traversal on the packaged application',
    ],
  },
  {
    id: 'desktop-windows-package',
    title: 'Packaged Windows acceptance',
    source: 'packaged-desktop',
    platform: 'windows',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'Dell XPS 13 9340',
    expectedOsVersion: 'Windows 11 24H2',
    expectedPackage: /^Podium_.+_x64-setup\.exe$/,
    expectedPackageDescription: 'Podium_<version>_x64-setup.exe',
    covers: [
      'NSIS install and uninstall on Windows 11 x86_64',
      'WebView2 launch, native opener and dialogs, clipboard, ConPTY, and updater restart',
      'Narrator and keyboard traversal; preview remains until this check passes',
    ],
  },
  {
    id: 'desktop-linux-package',
    title: 'Packaged Linux acceptance',
    source: 'packaged-desktop',
    platform: 'linux',
    owner: 'parity-release-proof',
    deviceRequired: true,
    expectedDevice: 'ThinkPad T14 Gen 4 AMD',
    expectedOsVersion: 'Ubuntu 24.04.3 LTS',
    expectedPackage: /^Podium_.+_amd64\.AppImage$/,
    expectedPackageDescription: 'Podium_<version>_amd64.AppImage',
    covers: [
      'AppImage launch on Ubuntu 24.04 x86_64 under an isolated X11 session',
      'native opener and dialogs, clipboard, PTY, replacement, and updater restart',
      'Orca and keyboard traversal; preview remains until this check passes',
    ],
  },
]

export type EvidenceEntry = {
  status: EvidenceStatus
  source: EvidenceSource
  observedAt?: string
  platform?: string
  device?: string
  osVersion?: string
  commit?: string
  artifacts?: string[]
  packageName?: string
  packageSha256?: string
  notes: string
}

export type EvidenceFile = {
  schemaVersion: number
  candidate: { commit: string; version: string; createdAt: string }
  checks: Record<string, EvidenceEntry>
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function parseEvidence(value: unknown): EvidenceFile {
  const root = asObject(value, 'evidence')
  if (root.schemaVersion !== PROOF_SCHEMA_VERSION) {
    throw new Error(`evidence schemaVersion must be ${PROOF_SCHEMA_VERSION}`)
  }
  const candidate = asObject(root.candidate, 'evidence.candidate')
  for (const key of ['commit', 'version', 'createdAt']) {
    if (typeof candidate[key] !== 'string' || candidate[key] === '') {
      throw new Error(`evidence.candidate.${key} must be a non-empty string`)
    }
  }
  const checks = asObject(root.checks, 'evidence.checks')
  const parsedChecks: Record<string, EvidenceEntry> = {}
  const validStatuses = new Set<EvidenceStatus>(['passed', 'failed', 'unavailable'])
  const validSources = new Set<EvidenceSource>([
    'automated',
    'simulator',
    'physical-device',
    'packaged-desktop',
    'unavailable',
  ])
  for (const [id, raw] of Object.entries(checks)) {
    const entry = asObject(raw, `evidence.checks.${id}`)
    if (!validStatuses.has(entry.status as EvidenceStatus)) {
      throw new Error(`evidence.checks.${id}.status is invalid`)
    }
    if (!validSources.has(entry.source as EvidenceSource)) {
      throw new Error(
        `evidence.checks.${id}.source is invalid; browser emulation is never native proof`,
      )
    }
    if (typeof entry.notes !== 'string' || entry.notes === '') {
      throw new Error(`evidence.checks.${id}.notes must be a non-empty string`)
    }
    if (entry.artifacts !== undefined) {
      if (
        !Array.isArray(entry.artifacts) ||
        entry.artifacts.some((artifact) => typeof artifact !== 'string' || artifact === '')
      ) {
        throw new Error(`evidence.checks.${id}.artifacts must contain non-empty strings`)
      }
    }
    for (const key of [
      'observedAt',
      'platform',
      'device',
      'osVersion',
      'commit',
      'packageName',
      'packageSha256',
    ]) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') {
        throw new Error(`evidence.checks.${id}.${key} must be a string`)
      }
    }
    parsedChecks[id] = {
      status: entry.status as EvidenceStatus,
      source: entry.source as EvidenceSource,
      notes: entry.notes as string,
      ...(entry.observedAt ? { observedAt: entry.observedAt as string } : {}),
      ...(entry.platform ? { platform: entry.platform as string } : {}),
      ...(entry.device ? { device: entry.device as string } : {}),
      ...(entry.osVersion ? { osVersion: entry.osVersion as string } : {}),
      ...(entry.commit ? { commit: entry.commit as string } : {}),
      ...(entry.artifacts ? { artifacts: entry.artifacts as string[] } : {}),
      ...(entry.packageName ? { packageName: entry.packageName as string } : {}),
      ...(entry.packageSha256 ? { packageSha256: entry.packageSha256 as string } : {}),
    }
  }
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    candidate: {
      commit: candidate.commit as string,
      version: candidate.version as string,
      createdAt: candidate.createdAt as string,
    },
    checks: parsedChecks,
  }
}

export function validateEvidence(
  evidence: EvidenceFile,
  options: { releaseReady: boolean; expectedCommit?: string },
): string[] {
  const errors: string[] = []
  const expectedIds = new Set(PROOF_CHECKS.map((check) => check.id))
  for (const id of Object.keys(evidence.checks)) {
    if (!expectedIds.has(id)) errors.push(`unknown proof check: ${id}`)
  }
  if (options.expectedCommit && evidence.candidate.commit !== options.expectedCommit) {
    errors.push(
      `candidate commit ${evidence.candidate.commit} does not match HEAD ${options.expectedCommit}`,
    )
  }
  for (const check of PROOF_CHECKS) {
    const entry = evidence.checks[check.id]
    if (!entry) {
      errors.push(`missing proof check: ${check.id}`)
      continue
    }
    if (entry.status === 'unavailable') {
      if (entry.source !== 'unavailable') {
        errors.push(`${check.id}: unavailable status must use unavailable source`)
      }
      if (options.releaseReady) errors.push(`${check.id}: unavailable evidence blocks release`)
      continue
    }
    if (entry.source !== check.source) {
      errors.push(`${check.id}: expected ${check.source} evidence, found ${entry.source}`)
    }
    if (check.deviceRequired && (!entry.device || !entry.osVersion)) {
      errors.push(`${check.id}: device and osVersion are required`)
    }
    if (check.expectedDevice && entry.device !== check.expectedDevice) {
      errors.push(`${check.id}: expected device ${check.expectedDevice}, found ${entry.device}`)
    }
    if (check.expectedOsVersion && entry.osVersion !== check.expectedOsVersion) {
      errors.push(`${check.id}: expected OS ${check.expectedOsVersion}, found ${entry.osVersion}`)
    }
    if (
      check.expectedPackage &&
      (!entry.packageName || !check.expectedPackage.test(entry.packageName))
    ) {
      errors.push(
        `${check.id}: expected package ${check.expectedPackageDescription}, found ${entry.packageName}`,
      )
    }
    if (check.expectedPackage && !/^[a-f0-9]{64}$/i.test(entry.packageSha256 ?? '')) {
      errors.push(`${check.id}: packageSha256 must be the package's 64-character SHA-256`)
    }
    if (entry.status === 'passed' && (entry.artifacts?.length ?? 0) === 0) {
      errors.push(`${check.id}: passed evidence needs at least one artifact or run URL`)
    }
    if (entry.commit && entry.commit !== evidence.candidate.commit) {
      errors.push(`${check.id}: evidence commit does not match the candidate`)
    }
    if (options.releaseReady && entry.status !== 'passed') {
      errors.push(`${check.id}: ${entry.status} evidence blocks release`)
    }
    if (options.releaseReady && entry.status === 'passed') {
      if (!entry.observedAt) errors.push(`${check.id}: passed evidence needs observedAt`)
      if (entry.platform !== check.platform) {
        errors.push(`${check.id}: expected platform ${check.platform}, found ${entry.platform}`)
      }
      if (!entry.commit) errors.push(`${check.id}: passed evidence needs its candidate commit`)
    }
  }
  return errors
}

function currentCommit(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

export function evidenceTemplate(commit: string): EvidenceFile {
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    candidate: {
      commit,
      version: 'replace-with-release-version',
      createdAt: new Date().toISOString(),
    },
    checks: Object.fromEntries(
      PROOF_CHECKS.map((check) => [
        check.id,
        {
          status: 'unavailable',
          source: 'unavailable',
          notes: `Not recorded. Required source: ${check.source}.`,
        } satisfies EvidenceEntry,
      ]),
    ),
  }
}

export function inspectProofContract(root: string): string[] {
  const errors: string[] = []
  const app = readJson(resolve(root, 'apps/mobile/app.json')) as {
    expo?: { ios?: Record<string, unknown>; plugins?: unknown[] }
  }
  const ios = app.expo?.ios
  if (ios?.supportsTablet !== false) errors.push('mobile release must be iPhone-only')
  const infoPlist = asObject(ios?.infoPlist, 'apps/mobile/app.json ios.infoPlist')
  if (infoPlist.MinimumOSVersion !== IOS_DEPLOYMENT_TARGET) {
    errors.push(`mobile MinimumOSVersion must be ${IOS_DEPLOYMENT_TARGET}`)
  }
  if (!app.expo?.plugins?.includes('./plugins/with-ios-release-contract')) {
    errors.push('mobile app must apply with-ios-release-contract')
  }

  const plugin = readFileSync(
    resolve(root, 'apps/mobile/plugins/with-ios-release-contract.js'),
    'utf8',
  )
  for (const required of [
    `const deploymentTarget = '${IOS_DEPLOYMENT_TARGET}'`,
    'IPHONEOS_DEPLOYMENT_TARGET',
    "TARGETED_DEVICE_FAMILY = '1'",
  ]) {
    if (!plugin.includes(required)) errors.push(`iOS release plugin is missing ${required}`)
  }

  const eas = readJson(resolve(root, 'apps/mobile/eas.json')) as {
    build?: Record<string, Record<string, unknown>>
    submit?: Record<string, unknown>
  }
  if ((eas.build?.simulator?.ios as { simulator?: boolean } | undefined)?.simulator !== true) {
    errors.push('EAS simulator profile must produce an iOS simulator build')
  }
  if (eas.build?.device?.distribution !== 'internal') {
    errors.push('EAS device profile must use internal distribution')
  }
  if (
    eas.build?.production?.distribution !== 'store' ||
    eas.build?.production?.autoIncrement !== true
  ) {
    errors.push('EAS production profile must use store distribution and autoIncrement')
  }
  if (!eas.submit || !('production' in eas.submit)) {
    errors.push('EAS production submit profile is missing')
  }

  const pkg = readJson(resolve(root, 'package.json')) as { scripts?: Record<string, string> }
  if (pkg.scripts?.['release:proof'] !== 'bun scripts/parity-release-proof.ts') {
    errors.push('package.json release:proof command is missing')
  }

  const docs = readFileSync(resolve(root, 'docs/parity-release-proof.md'), 'utf8')
  for (const required of [
    'Browser emulation never counts as native proof.',
    'coordinator approval',
    'TestFlight',
    'Windows and Linux remain preview',
  ]) {
    if (!docs.includes(required)) errors.push(`release proof docs are missing: ${required}`)
  }
  return errors
}

function printStatus(evidence: EvidenceFile): void {
  for (const check of PROOF_CHECKS) {
    const entry = evidence.checks[check.id]
    console.log(`${entry?.status ?? 'missing'}\t${check.id}\t${check.title}`)
  }
}

function usage(): never {
  console.error(
    'usage: bun run release:proof -- check | status [--evidence <file>] | template --out <file> | verify --evidence <file>',
  )
  process.exit(2)
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, '..')
  const [command = 'check', ...args] = process.argv.slice(2)
  const baselinePath = resolve(root, 'scripts/parity-release-proof-baseline.json')
  if (command === 'template') {
    const output = option(args, '--out')
    if (!output) usage()
    const outputPath = resolve(root, output)
    const relativeOutput = relative(root, outputPath)
    if (relativeOutput.startsWith('..') || relativeOutput === '') {
      throw new Error('release proof template output must be a file inside this worktree')
    }
    if (existsSync(outputPath)) {
      throw new Error(`release proof template refuses to overwrite ${output}`)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(evidenceTemplate(currentCommit(root)), null, 2)}\n`)
    console.log(`wrote release proof template to ${output}`)
    return
  }
  if (command === 'check') {
    const evidence = parseEvidence(readJson(baselinePath))
    const errors = [
      ...inspectProofContract(root),
      ...validateEvidence(evidence, { releaseReady: false }),
    ]
    if (errors.length > 0) {
      for (const error of errors) console.error(`release proof: ${error}`)
      process.exit(1)
    }
    console.log(
      `release proof contract OK, ${PROOF_CHECKS.length} checks; baseline is not a release approval`,
    )
    return
  }
  const evidencePath = option(args, '--evidence')
  const evidence = parseEvidence(
    readJson(evidencePath ? resolve(root, evidencePath) : baselinePath),
  )
  if (command === 'status') {
    printStatus(evidence)
    return
  }
  if (command === 'verify') {
    if (!evidencePath) usage()
    const errors = validateEvidence(evidence, {
      releaseReady: true,
      expectedCommit: currentCommit(root),
    })
    if (errors.length > 0) {
      for (const error of errors) console.error(`release proof: ${error}`)
      process.exit(1)
    }
    console.log(`release proof passed for ${evidence.candidate.commit}`)
    return
  }
  usage()
}

if (import.meta.main) await main()
