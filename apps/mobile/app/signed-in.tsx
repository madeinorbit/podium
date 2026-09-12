import { Redirect } from 'expo-router'
/** The profile gate consumes the OS callback; never render its one-time code. */
export default function SignedIn() {
  return <Redirect href="/" />
}
