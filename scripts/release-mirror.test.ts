import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MIRROR_RELEASE_ORIGIN,
  PRIMARY_RELEASE_ORIGIN,
  releaseTagPath,
  releaseUrl,
} from '../packages/runtime/src/release-origins'
import { mirrorManifest, mirrorUploadPrefixes, publishReleaseMirror } from './release-mirror'

describe('mirror publication preparation', () => {
  it('keeps the prior rolling alias until the new manifest has been published', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-mirror-order-'))
    try {
      const names = ['fixed.tar.gz', 'immutable.tar.gz', 'podium-update.json']
      for (const name of names)
        writeFileSync(join(dir, name), name.endsWith('.json') ? '{}' : 'new')
      const uploaded: string[] = []
      const exec = vi.fn((_command: string, args: string[]) => {
        const file = basename(args[2] ?? '')
        if (file === 'podium-update.json') {
          expect(uploaded).toContain('immutable.tar.gz')
          expect(uploaded).not.toContain('fixed.tar.gz')
        }
        uploaded.push(file)
      })
      publishReleaseMirror(
        {
          channel: 'edge',
          tag: 'edge',
          files: names.map((name) => join(dir, name)),
          aliases: [join(dir, 'fixed.tar.gz')],
        },
        {
          PODIUM_PUBLISH_RELEASE_MIRROR: '1',
          PODIUM_RELEASE_R2_ENDPOINT: 'https://test.invalid',
          PODIUM_RELEASE_R2_BUCKET: 'fixture',
          AWS_ACCESS_KEY_ID: 'fixture',
          AWS_SECRET_ACCESS_KEY: 'fixture',
        },
        exec as never,
      )
      expect(uploaded).toEqual(['immutable.tar.gz', 'podium-update.json', 'fixed.tar.gz'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does nothing by default, even without files or credentials', () => {
    const exec = vi.fn()
    publishReleaseMirror(
      { channel: 'stable', tag: 'v1.0.0', files: ['/does-not-exist'] },
      {},
      exec as never,
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('copies stable into latest without promoting edge or dev', () => {
    expect(mirrorUploadPrefixes('stable', 'v1.0.0')).toEqual(['download/v1.0.0/', 'latest/'])
    expect(mirrorUploadPrefixes('edge', 'edge')).toEqual(['download/edge/'])
    expect(mirrorUploadPrefixes('dev', 'dev')).toEqual(['download/dev/'])
  })

  it('rebinds artifact references while preserving signatures, digests and notes', () => {
    const path = releaseTagPath('v1.0.0') + 'a.tgz'
    const asset = {
      url: releaseUrl(path, PRIMARY_RELEASE_ORIGIN),
      signature: 'signed',
      digest: 'sha256-bytes',
    }
    const manifest = {
      version: '1.0.0',
      artifacts: { headless: { delivery: 'feed', platforms: { linux: asset } } },
      notes: { url: 'https://example.com/notes' },
    }
    const mirrored = JSON.parse(mirrorManifest(JSON.stringify(manifest)))
    expect(mirrored.artifacts.headless.platforms.linux).toEqual({
      ...asset,
      url: releaseUrl(path, MIRROR_RELEASE_ORIGIN),
    })
    expect(mirrored.notes).toEqual(manifest.notes)
  })

  it('rebinds embedded desktop deliveries as well as standalone desktop manifests', () => {
    const asset = {
      url: releaseUrl('download/edge/shell.tgz'),
      signature: 'signed',
      digest: 'digest',
    }
    const text = JSON.stringify({ artifacts: { desktop: { platforms: { linux: asset } } } })
    expect(JSON.parse(mirrorManifest(text)).artifacts.desktop.platforms.linux).toEqual({
      ...asset,
      url: releaseUrl('download/edge/shell.tgz', MIRROR_RELEASE_ORIGIN),
    })
  })

  it('requires credentials only after explicit activation', () => {
    expect(() =>
      publishReleaseMirror(
        { channel: 'edge', tag: 'edge', files: [] },
        { PODIUM_PUBLISH_RELEASE_MIRROR: '1' },
      ),
    ).toThrow('CI-only')
  })
})
