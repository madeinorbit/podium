/**
 * @podium/blob-store: one small byte interface for user files [POD-6963 design 2.1].
 *
 * The root exports the interface, keys and errors. The adapters sit behind
 * their own subpaths: `./local` (node:fs, the self-hosted state directory),
 * `./s3` (an S3-compatible bucket, a prefix per workspace) and `./memory`
 * (tests). `./testing` is the contract suite every adapter passes, and
 * `./s3-fake` an in-process S3 server for tests.
 */

export {
  type BlobKey,
  blobKey,
  decodeKeySegment,
  InvalidBlobKey,
  isBlobKey,
  isKeySegment,
  joinKey,
  keySegment,
  MAX_ENCODED_ID_BYTES,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  padNumber,
  parsePadded,
  TEMP_PREFIX,
} from './key'
export {
  type BlobBody,
  BlobConditionFailed,
  type BlobCopyOptions,
  type BlobDeleteOptions,
  type BlobGetResult,
  type BlobHead,
  type BlobListEntry,
  BlobNotFound,
  type BlobPutOptions,
  type BlobRange,
  type BlobStorage,
  type BlobStore,
  LOCAL_WORKSPACE_ID,
  type PortableStateWriteFence,
} from './types'
