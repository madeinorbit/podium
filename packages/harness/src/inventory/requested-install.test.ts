import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { harnessHomeVariable } from '../registry'
import { managedInstallRefusal, requestManagedInstall } from './requested-install'

describe('section 4.7 install admission over the registry', () => {
  it.each(
    BUILTIN_HARNESS_KINDS,
  )('%s allows an empty machine and requires a folder variable alongside a personal copy', async (kind) => {
    expect(managedInstallRefusal(kind, false)).toBeUndefined()
    if (harnessHomeVariable(kind)) {
      expect(managedInstallRefusal(kind, true)).toBeUndefined()
      expect(managedInstallRefusal(kind, null)).toBeUndefined()
    } else {
      expect(managedInstallRefusal(kind, true)).toContain('no folder variable')
      expect(managedInstallRefusal(kind, null)).toContain('could not check')
      await expect(
        requestManagedInstall(kind, true, { harnessesDir: '/not-written' }),
      ).rejects.toThrow('no folder variable')
    }
  })
})
