import { Redirect } from 'expo-router'
/**
 * The profile gate consumes pairing links; never render their secret. The
 * native intent already sends them to `/`; this covers any path that skips it.
 */
export default function Pair() {
  return <Redirect href="/" />
}
