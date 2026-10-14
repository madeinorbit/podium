/**
 * AN ATTACHMENT STAGER WITH NO DISK BEHIND IT (POD-6093).
 *
 * Every family host takes the daemon's stager. A family runtime built on its
 * own — a unit test, a conformance fixture — gets this stand-in: it mints a
 * ref the way the daemon does and writes nothing, so a test that never reads
 * the bytes back needs no scratch directory. Production never constructs one.
 */

import { type AttachmentStager, attachmentKindFor } from '../turns.js'

export function createMemoryAttachmentStager(): AttachmentStager {
  let seq = 0
  return async ({ sessionId, source }) => {
    const id = `attachment-${++seq}`
    return {
      id,
      path: `/tmp/podium-test-uploads/${sessionId}/${id}-${source.filename}`,
      filename: source.filename,
      mediaType: source.mediaType,
      kind: attachmentKindFor(source.mediaType),
    }
  }
}
