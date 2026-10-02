export function describeWireSkew(
  skew: { quarantined: number; refusedFrames: number },
  delivery: 'browser' | 'native' = 'browser',
): { source: 'dropped-frames'; severe: boolean; message: string } {
  const severe = skew.refusedFrames > 0
  if (delivery === 'native')
    return {
      source: 'dropped-frames',
      severe,
      message: severe
        ? 'This app build cannot read what the server is sending, so parts of it may be empty or stuck. Update Podium on this device to pick up a newer build.'
        : `${skew.quarantined} item${skew.quarantined === 1 ? '' : 's'} from the server could not be read by this app build and are missing from these views. Update Podium on this device to pick up a newer build.`,
    }
  return {
    source: 'dropped-frames',
    severe,
    message: severe
      ? 'This app build cannot read what the server is sending, so parts of it may be ' +
        'empty or stuck. It is older than the server. Reload to pick up a newer build — ' +
        'if that does not help, the build being served needs rebuilding.'
      : `${skew.quarantined} item${skew.quarantined === 1 ? '' : 's'} from the server could ` +
        'not be read by this app build and are missing from these views. Reload to pick up ' +
        'a newer build.',
  }
}
