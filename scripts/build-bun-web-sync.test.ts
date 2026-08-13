import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWebDirMatches, syncBundleWeb } from './build-bun'

const made: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/build-bun-web-`)
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A minimal apps/web/dist: an index plus one content-hashed asset. */
const writeWebDist = (dir: string, hash: string): void => {
  mkdirSync(`${dir}/assets`, { recursive: true })
  writeFileSync(`${dir}/index.html`, `<script src="/assets/main-${hash}.js"></script>`)
  writeFileSync(`${dir}/assets/main-${hash}.js`, 'console.log(1)')
}

describe('syncBundleWeb', () => {
  it('drops the previous build’s content-hashed assets', () => {
    const root = scratch()
    const src = `${root}/dist`
    const dest = `${root}/headless/web`
    // A bundle built six weeks ago, whose assets Vite will never emit again.
    mkdirSync(`${dest}/assets`, { recursive: true })
    writeFileSync(`${dest}/assets/main-stale111.js`, 'dead weight')
    writeWebDist(src, 'fresh222')

    syncBundleWeb(src, dest)

    expect(readdirSync(`${dest}/assets`)).toEqual(['main-fresh222.js'])
  })

  it('copies the whole current build in', () => {
    const root = scratch()
    const src = `${root}/dist`
    const dest = `${root}/headless/web`
    writeWebDist(src, 'fresh222')

    syncBundleWeb(src, dest)

    expect(existsSync(`${dest}/index.html`)).toBe(true)
    expect(existsSync(`${dest}/assets/main-fresh222.js`)).toBe(true)
  })

  it('creates the web dir on a first build, with nothing there to prune', () => {
    const root = scratch()
    const src = `${root}/dist`
    writeWebDist(src, 'fresh222')

    expect(() => syncBundleWeb(src, `${root}/headless/web`)).not.toThrow()
    expect(existsSync(`${root}/headless/web/assets/main-fresh222.js`)).toBe(true)
  })

  it('leaves the bundle file-for-file the build', () => {
    const root = scratch()
    const src = `${root}/dist`
    const dest = `${root}/headless/web`
    mkdirSync(`${dest}/assets`, { recursive: true })
    writeFileSync(`${dest}/assets/main-stale111.js`, 'dead weight')
    writeWebDist(src, 'fresh222')

    syncBundleWeb(src, dest)

    expect(() => assertWebDirMatches(src, dest)).not.toThrow()
  })
})

// The guard syncBundleWeb runs after copying. Exercised directly so it is proven able to
// fire: once the prune works, no reachable state through syncBundleWeb makes it throw.
describe('assertWebDirMatches', () => {
  it('names a bundle file the current build did not emit', () => {
    const root = scratch()
    const src = `${root}/dist`
    const dest = `${root}/headless/web`
    writeWebDist(src, 'fresh222')
    writeWebDist(dest, 'fresh222')
    writeFileSync(`${dest}/assets/main-stale111.js`, 'dead weight')

    expect(() => assertWebDirMatches(src, dest)).toThrow(/main-stale111\.js/)
  })

  it('names a build file missing from the bundle', () => {
    const root = scratch()
    const src = `${root}/dist`
    const dest = `${root}/headless/web`
    writeWebDist(src, 'fresh222')
    writeWebDist(dest, 'fresh222')
    rmSync(`${dest}/assets/main-fresh222.js`)

    expect(() => assertWebDirMatches(src, dest)).toThrow(/main-fresh222\.js/)
  })
})
