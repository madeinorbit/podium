import { expect, test } from 'vitest'
import { httpsRequiredRefusal, readHttpsRequiredRefusal, signInHttpsUrl } from './https-required'

test.each([
  undefined,
  'http://podium.example',
  'javascript:alert(1)',
  'https://user:pass@podium.example',
  'https://podium.example/#secret',
  'https://podium.example/?token=secret',
])('does not advertise unsafe HTTPS destination %s', (url) => {
  expect(signInHttpsUrl(url)).toBeNull()
  expect(httpsRequiredRefusal(url).httpsUrl).toBeNull()
})

test('only the HTTPS refusal code selects the guidance, including old code-only servers', () => {
  expect(readHttpsRequiredRefusal({ error: 'https_required' })).toEqual(httpsRequiredRefusal())
  expect(readHttpsRequiredRefusal({ error: 'unauthorized' })).toBeUndefined()
  expect(readHttpsRequiredRefusal({ error: { message: 'https_required' } })).toBeUndefined()
  expect(readHttpsRequiredRefusal(null)).toBeUndefined()
})

test('reads server copy while validating the configured sign-in address and keeping the setup link', () => {
  expect(
    readHttpsRequiredRefusal({
      error: 'https_required',
      message: 'Server explanation',
      httpsUrl: 'https://podium.example/',
      docsUrl: 'javascript:alert(1)',
    }),
  ).toEqual({ ...httpsRequiredRefusal('https://podium.example'), message: 'Server explanation' })
})
