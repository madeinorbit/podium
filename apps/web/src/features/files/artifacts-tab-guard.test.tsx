import { asArtifactId, asIssueId } from '@podium/model/browser'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { scopedAssetUrl } from '@/lib/asset-url'
import { ARTIFACTS_TAB_ARTIFACT_ID } from './artifacts-tab-id'
import { FilePanel } from './FilePanel'
import { FileDocumentView } from './file-document-view'
import { downloadFileUrl, rawFileUrl } from './open-in-browser'

// POD-2078: the Artifacts index rides an artifact-scoped file tab whose id names
// no stored artifact. Every route that turns a scope into bytes must refuse it.
const issueId = asIssueId('iss_1')
const sentinel = { kind: 'artifact' as const, issueId, artifactId: ARTIFACTS_TAB_ARTIFACT_ID }
const real = { kind: 'artifact' as const, issueId, artifactId: asArtifactId('art_1') }
const notices = { success: vi.fn(), error: vi.fn() }

describe('the Artifacts tab sentinel never reaches a fetch', () => {
  it('builds no asset, raw or download URL', () => {
    const args = { httpOrigin: 'http://h', fileDir: '', src: 'Artifacts', workspace: '' }
    expect(scopedAssetUrl({ ...args, scope: sentinel })).toBeNull()
    expect(rawFileUrl({ httpOrigin: 'http://h', scope: sentinel, path: 'Artifacts' })).toBeNull()
    expect(
      downloadFileUrl({ httpOrigin: 'http://h', scope: sentinel, path: 'Artifacts' }),
    ).toBeNull()
    // Positive control: a real snapshot still gets its URL.
    expect(scopedAssetUrl({ ...args, scope: real })).toContain('/files/artifact/iss_1/art_1/')
  })

  it('answers a document read locally instead of calling the server', async () => {
    const readFileScoped = vi.fn(async () => ({ ok: true, content: 'x', baseHash: 'h' }))
    const ports = { readFileScoped, writeFileScoped: vi.fn() }
    await new FileDocumentView(sentinel, 'Artifacts', ports, notices).open()
    expect(readFileScoped).not.toHaveBeenCalled()
    await new FileDocumentView(real, 'notes.md', ports, notices).open()
    expect(readFileScoped).toHaveBeenCalledTimes(1)
  })

  it('mounts no file viewer for it', () => {
    const { container } = render(<FilePanel scope={sentinel} path="Artifacts" onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
