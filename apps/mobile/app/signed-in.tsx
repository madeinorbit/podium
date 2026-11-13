import { Redirect } from 'expo-router'
import { MOBILE_HOME } from '../src/lib/navigation'

/** The profile gate consumes the OS callback; never render its one-time code. */
export default function SignedIn() {
  return <Redirect href={MOBILE_HOME} />
}
