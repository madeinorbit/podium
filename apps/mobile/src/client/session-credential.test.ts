import { describe, expect, it } from 'vitest'
import { OTHER_MEMBERS_LABEL, OWN_LOGIN_LABEL, sessionCredentialLabel } from './session-credential'

const views = [{ id: 'cred_a', label: 'Max plan' }] as never

describe('acceptance 2: the phone names the credential a session runs on', () => {
  it('by its label', () => {
    expect(sessionCredentialLabel('cred_a', views)).toBe('Max plan')
  })
  it('the harness’s own login when it names none', () => {
    expect(sessionCredentialLabel(undefined, undefined)).toBe(OWN_LOGIN_LABEL)
    expect(sessionCredentialLabel(null, views)).toBe(OWN_LOGIN_LABEL)
  })
  it('one the viewer cannot see, neutrally; nothing until the list is known', () => {
    expect(sessionCredentialLabel('cred_b', views)).toBe(OTHER_MEMBERS_LABEL)
    expect(sessionCredentialLabel('cred_b', undefined)).toBeUndefined()
  })
})
