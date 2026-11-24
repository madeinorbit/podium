import { Redirect } from 'expo-router'

/** Super is a desktop and web surface; iOS never bundles its screen. */
export default function SuperagentUnavailable() {
  return <Redirect href="/work" />
}
