#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

interface SourceMap {
  readonly sources: readonly string[]
  readonly sourcesContent?: readonly (string | null)[]
}

interface Bytes {
  readonly raw: number
  readonly gzip: number
  readonly brotli: number
}

interface ChunkReport extends Bytes {
  readonly file: string
  readonly sources: readonly string[]
  readonly sourceBytes: number
}

interface SourcesReport {
  readonly sources: readonly string[]
}

const args = process.argv.slice(2)
const checkBudget = args.includes('--check')
const dist = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'apps/web/dist')
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')

function compressedBytes(path: string): Bytes {
  const contents = readFileSync(path)
  return {
    raw: contents.byteLength,
    gzip: gzipSync(contents, { level: 9 }).byteLength,
    brotli: brotliCompressSync(contents, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  }
}

function addBytes(left: Bytes, right: Bytes): Bytes {
  return {
    raw: left.raw + right.raw,
    gzip: left.gzip + right.gzip,
    brotli: left.brotli + right.brotli,
  }
}

function sourceMapFor(jsFile: string): SourceMap {
  const path = `${join(dist, jsFile)}.map`
  if (!existsSync(path)) return { sources: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as SourceMap
}

function chunkReport(jsFile: string): ChunkReport {
  const map = sourceMapFor(jsFile)
  return {
    file: jsFile,
    ...compressedBytes(join(dist, jsFile)),
    sources: map.sources,
    sourceBytes: map.sources.reduce(
      (total, _source, index) =>
        total + Buffer.byteLength(map.sourcesContent?.[index] ?? '', 'utf8'),
      0,
    ),
  }
}

function htmlJsReferences(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/(?:src|href)="\/?([^"?]+\.js)(?:\?[^"?]*)?"/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ]
}

function findChunk(prefix: string): string {
  const matches = readdirSync(join(dist, 'assets'))
    .filter((file) => file.startsWith(prefix) && file.endsWith('.js'))
    .map((file) => `assets/${file}`)
  if (matches.length !== 1)
    throw new Error(`expected one ${prefix}*.js chunk, found ${matches.length}`)
  return matches[0] as string
}

function matchingSources(chunks: readonly SourcesReport[], fragment: string): string[] {
  return [
    ...new Set(
      chunks.flatMap((chunk) => chunk.sources.filter((source) => source.includes(fragment))),
    ),
  ].sort()
}

const eagerChunks = htmlJsReferences(indexHtml).map(chunkReport)
const eagerBytes = eagerChunks.reduce<Bytes>(addBytes, { raw: 0, gzip: 0, brotli: 0 })
const settings = chunkReport(findChunk('SettingsView-'))
const allChunks = readdirSync(join(dist, 'assets'))
  .filter((file) => file.endsWith('.js') && statSync(join(dist, 'assets', file)).isFile())
  .map((file) => sourceMapFor(`assets/${file}`))

const report = {
  dist,
  eager: {
    ...eagerBytes,
    files: eagerChunks.map((chunk) => basename(chunk.file)),
    sourceBytes: eagerChunks.reduce((total, chunk) => total + chunk.sourceBytes, 0),
    ownershipMatrixSources: matchingSources(
      eagerChunks,
      'packages/model/src/annotations/matrix.ts',
    ),
    commandSources: matchingSources(eagerChunks, 'packages/commands/src/'),
  },
  settings: {
    file: basename(settings.file),
    raw: settings.raw,
    gzip: settings.gzip,
    brotli: settings.brotli,
    sourceBytes: settings.sourceBytes,
    ownershipMatrixSources: matchingSources(
      [settings],
      'packages/model/src/annotations/matrix.ts',
    ),
    commandSources: matchingSources([settings], 'packages/commands/src/'),
  },
  allBrowserChunks: {
    ownershipMatrixSources: matchingSources(
      allChunks,
      'packages/model/src/annotations/matrix.ts',
    ),
  },
}

console.log(JSON.stringify(report, null, 2))

if (checkBudget) {
  const errors: string[] = []
  const atMost = (label: string, actual: number, budget: number) => {
    if (actual > budget) errors.push(`${label}: ${actual} exceeds ${budget}`)
  }

  atMost('eager raw bytes', report.eager.raw, 2_200_000)
  atMost('eager gzip bytes', report.eager.gzip, 655_000)
  atMost('eager Brotli bytes', report.eager.brotli, 545_000)
  atMost('eager parsed source bytes', report.eager.sourceBytes, 7_400_000)
  atMost('settings raw bytes', report.settings.raw, 105_000)
  atMost('settings gzip bytes', report.settings.gzip, 30_000)
  atMost('settings Brotli bytes', report.settings.brotli, 26_000)
  atMost('settings parsed source bytes', report.settings.sourceBytes, 280_000)

  if (report.eager.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in the eager graph')
  if (report.allBrowserChunks.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in a browser chunk')
  if (report.eager.commandSources.length > 0)
    errors.push(`command sources are eager: ${report.eager.commandSources.join(', ')}`)

  const allowedSettingsCommandSources = new Set([
    'packages/commands/src/settings/write-plan.ts',
    'packages/commands/src/settings/write-policy.ts',
  ])
  const unrelatedSettingsCommands = report.settings.commandSources.filter(
    (source) =>
      ![...allowedSettingsCommandSources].some((allowed) => source.endsWith(allowed)),
  )
  if (unrelatedSettingsCommands.length > 0)
    errors.push(`unrelated settings command sources: ${unrelatedSettingsCommands.join(', ')}`)

  if (errors.length > 0) {
    for (const error of errors) console.error(`[web-bundle-budget] ${error}`)
    process.exitCode = 1
  }
}
