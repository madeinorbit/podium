/**
 * The "Subscription" entry of the credentials page's add menu (credential
 * management §6 way 2; epic Task 9).
 */

import { registerAddEntry } from '../add-menu'
import { AddSubscriptionSection } from './section'

registerAddEntry({
  key: 'subscription',
  label: 'Subscription',
  hint: 'Sign in to Claude or ChatGPT on one of your machines',
  render: ({ deps, done }) => <AddSubscriptionSection deps={deps} onDone={done} />,
})
