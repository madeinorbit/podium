import type { HarnessDescriptorData } from '../../descriptor-types.js'

export const antigravityDescriptor: HarnessDescriptorData = {
  kind: 'antigravity',
  provider: 'google',
  label: 'Antigravity',
  shortLabel: 'Antigravity',
  mark: 'AG',
  icon: {
    id: 'antigravity',
    viewBox: '0 0 24 24',
    d: 'M12 2 2 21h5l5-10 5 10h5L12 2Zm0 12-3 7h6l-3-7Z',
  },
  brand: { bg: '#182b42', fg: '#8ab4f8' },
  login: {
    command: 'agy acp --login',
    installHint: 'Install Google Antigravity CLI from antigravity.google/download.',
    signedOutHint: 'Sign in with your Google account to use your Google AI plan.',
  },
  defaults: { model: null, effort: null, panelMode: 'native' },
}
