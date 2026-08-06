import { Redirect } from 'expo-router'
import { MOBILE_HOME } from '../src/lib/navigation'

/** The install/root deep link lands on the issue-first Work surface. */
export default function MobileHome() {
  return <Redirect href={MOBILE_HOME} />
}
