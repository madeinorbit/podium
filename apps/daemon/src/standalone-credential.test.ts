import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPERVISOR_MACHINE_ID_ENV } from '@podium/runtime/machine-supervisor'
import { confirmSetupEnrollment, prepareSetupEnrollment } from '@podium/runtime/setup-enrollment'
import { describe, expect, it } from 'vitest'
import { saveToken } from './identity'
import { standaloneCredentialGap } from './standalone-credential'

const freshDir = () => mkdtempSync(join(tmpdir(), 'standalone-credential-'))
const unsupervised: NodeJS.ProcessEnv = {}

describe('standaloneCredentialGap', () => {
  it('names the state dir and the setup step when nothing can authenticate', () => {
    const dir = freshDir()
    const gap = standaloneCredentialGap(dir, unsupervised)
    expect(gap).toContain(dir)
    expect(gap).toContain('complete setup')
  })

  it('lets an enrolled machine key through', () => {
    const dir = freshDir()
    const request = prepareSetupEnrollment(true, true, dir)
    confirmSetupEnrollment(request.requestId, request.publicKey, dir)
    expect(standaloneCredentialGap(dir, unsupervised)).toBeUndefined()
  })

  it('waits on a pending setup request, which the server confirms', () => {
    const dir = freshDir()
    prepareSetupEnrollment(true, true, dir)
    expect(standaloneCredentialGap(dir, unsupervised)).toBeUndefined()
  })

  it('lets a stored machine token through', () => {
    const dir = freshDir()
    saveToken('stored-token', { dir })
    expect(standaloneCredentialGap(dir, unsupervised)).toBeUndefined()
  })

  it('never refuses a parent-supervised daemon, whose parent enrolls later', () => {
    const dir = freshDir()
    expect(standaloneCredentialGap(dir, { PODIUM_UNDER_PARENT: '1' })).toBeUndefined()
    expect(standaloneCredentialGap(dir, { [SUPERVISOR_MACHINE_ID_ENV]: 'm-1' })).toBeUndefined()
  })
})
