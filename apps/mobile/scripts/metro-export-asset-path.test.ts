import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const expoRequire = createRequire(require_.resolve('expo/metro-config'))
const metroRequire = createRequire(expoRequire.resolve('@expo/metro-config/package.json'))
const cliRoot = path.dirname(expoRequire.resolve('@expo/cli/package.json'))
const metroRoot = path.dirname(expoRequire.resolve('@expo/metro-config/package.json'))
const { getUniversalAssetData } = require_(path.join(metroRoot, 'build/transform-worker/getAssets.js'))
const { transform } = require_(path.join(metroRoot, 'build/transform-worker/asset-transformer.js'))
const { persistMetroAssetsAsync } = require_(path.join(cliRoot, 'build/src/export/persistMetroAssets.js'))
const generate = metroRequire('@babel/generator').default
const config = require_('../metro.config.js')
const canonicalize = require_('./metro-export-asset-path.js')
const projectRoot = path.resolve(__dirname, '..')
const publicPath = '/assets?export_path=/mobile/assets'
const scratch = mkdtempSync(path.join(tmpdir(), 'metro-export-assets-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type ExportedAsset = {
  hash: string
  name: string
  files: string[]
  scales: number[]
  httpServerLocation: string
  width?: number
}

async function exportedAsset(file: string): Promise<ExportedAsset> {
  return getUniversalAssetData(
    file,
    path.relative(projectRoot, file),
    config.transformer.assetPlugins,
    'web',
    publicPath,
  )
}

async function exportedFiles(asset: ExportedAsset) {
  const files = new Map<string, { contents: Buffer }>()
  await persistMetroAssetsAsync(projectRoot, [asset], {
    platform: 'web',
    outputDirectory: scratch,
    baseUrl: '/mobile',
    files,
  })
  return files
}

async function transformedCode(file: string) {
  const result = await transform({
    filename: path.relative(projectRoot, file),
    options: { platform: 'web', projectRoot, publicPath },
  }, 'unused-web-registry', config.transformer.assetPlugins)
  return generate(result.ast).code as string
}

describe('Metro exported asset paths', () => {
  it('keeps Bun cache and checkout locations out of exported URLs on every host', () => {
    const hash = '3656dcb247d3a6cd141f7601c2101125'
    for (const source of [
      '../../../../bun-install-cache/links/@expo-google-fonts+geist-mono@0.4.3-2a25012349fb7712/node_modules/@expo-google-fonts/geist-mono/400Regular',
      '../../../../../Users/runner/.bun/install/cache/links/font-package/node_modules/font',
      '../../../../../../home/mgw/.bun/install/cache/links/font-package/node_modules/font',
    ]) {
      const asset = { httpServerLocation: `${publicPath}/${source}`, hash, files: [source] }
      const result = canonicalize(asset)
      expect(result.httpServerLocation).toBe(`${publicPath}/${hash}`)
      expect(result.files).toBe(asset.files)
      expect(asset.httpServerLocation).toBe(`${publicPath}/${source}`)
    }
  })

  it('preserves development asset serving', () => {
    for (const httpServerLocation of ['/assets/fonts', '/assets/?unstable_path=./fonts']) {
      const asset = { httpServerLocation, hash: 'abc' }
      expect(canonicalize(asset)).toBe(asset)
    }
  })

  it('exports the real Geist Mono font with a matching transformed URL below MAX_PATH', async () => {
    const file = realpathSync(require_.resolve('@expo-google-fonts/geist-mono/400Regular/GeistMono_400Regular.ttf'))
    const asset = await exportedAsset(file)
    const files = await exportedFiles(asset)
    expect(asset.files).toEqual([file])
    expect(asset.httpServerLocation).toBe(`/mobile/assets/${asset.hash}`)
    const [relative, output] = [...files.entries()][0]
    expect(relative).toBe(`assets/${asset.hash}/${asset.name}.ttf`)
    expect(output.contents).toEqual(readFileSync(file))
    expect(await transformedCode(file)).toContain(JSON.stringify(`/mobile/${relative.replaceAll(path.sep, '/')}`))
    const staged = path.win32.join('D:\\a\\podium\\podium\\apps\\desktop\\src-tauri\\resources\\payload\\mobile', relative)
    expect(staged.length).toBeLessThan(260)
  })

  it('keeps same-named assets with different contents distinct', async () => {
    const assets = []
    for (const folder of ['one', 'two']) {
      const dir = path.join(scratch, folder)
      mkdirSync(dir)
      const file = path.join(dir, 'font.ttf')
      writeFileSync(file, folder)
      assets.push(await exportedAsset(file))
    }
    const first = await exportedFiles(assets[0])
    const second = await exportedFiles(assets[1])
    expect([...first.keys()][0]).not.toBe([...second.keys()][0])
    expect([...first.values()][0].contents).toEqual(Buffer.from('one'))
    expect([...second.values()][0].contents).toEqual(Buffer.from('two'))
  })

  it('preserves image dimensions and every scale in one asset group', async () => {
    const dir = path.join(scratch, 'images')
    mkdirSync(dir)
    const png = readFileSync(path.join(projectRoot, 'assets/favicon.png'))
    const file = path.join(dir, 'icon.png')
    writeFileSync(file, png)
    writeFileSync(path.join(dir, 'icon@2x.png'), png)
    const asset = await exportedAsset(file)
    const files = await exportedFiles(asset)
    expect(asset.scales).toEqual([1, 2])
    expect(asset.width).toBeGreaterThan(0)
    expect([...files.keys()]).toEqual([
      path.join('assets', asset.hash, `${asset.name}.png`),
      path.join('assets', asset.hash, `${asset.name}@2x.png`),
    ])
    for (const output of files.values()) expect(output.contents).toEqual(png)
    expect(await transformedCode(file)).toContain(JSON.stringify(`/mobile/assets/${asset.hash}/${asset.name}.png`))
  })

  it('preserves WASM asset bytes and their transformed URL', async () => {
    const file = path.join(scratch, 'engine.wasm')
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
    writeFileSync(file, wasm)
    const asset = await exportedAsset(file)
    const files = await exportedFiles(asset)
    const [relative, output] = [...files.entries()][0]
    expect(output.contents).toEqual(wasm)
    expect(await transformedCode(file)).toContain(JSON.stringify(`/mobile/${relative.replaceAll(path.sep, '/')}`))
  })
})
