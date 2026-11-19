/**
 * The "ChatGPT plan" entry of the credentials page's add menu (credential
 * management §11; epic Task 14).
 */

import { registerAddEntry } from '../add-menu'
import { ChatgptSignInSection } from './section'

registerAddEntry({
  key: 'chatgpt-plan',
  label: 'ChatGPT plan',
  hint: 'Sign in with your ChatGPT account',
  render: ({ deps, done }) => <ChatgptSignInSection deps={deps} onDone={done} />,
})
