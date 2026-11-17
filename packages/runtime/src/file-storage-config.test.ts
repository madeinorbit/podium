import { describe, expect, it } from 'vitest'
import { PodiumConfig, resolveFileStorage } from './config'

const KEYS = {
  PODIUM_FILE_STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY: 'secret-value-never-quoted',
}

const S3_ENV = {
  PODIUM_FILE_STORAGE_BACKEND: 's3',
  PODIUM_FILE_STORAGE_ENDPOINT: 'https://account.r2.example.com',
  PODIUM_FILE_STORAGE_BUCKET: 'podium-files',
  PODIUM_FILE_STORAGE_REGION: 'auto',
  ...KEYS,
}

const config = (fileStorage?: PodiumConfig['fileStorage']): PodiumConfig =>
  PodiumConfig.parse(fileStorage === undefined ? {} : { fileStorage })

function failure(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected resolveFileStorage to throw')
}

describe('resolveFileStorage', () => {
  it('defaults to the local backend with nothing set', () => {
    expect(resolveFileStorage(config(), {})).toEqual({ backend: 'local' })
    expect(resolveFileStorage(config({ backend: 'local' }), {})).toEqual({ backend: 'local' })
  })

  it('reads the whole s3 backend from the environment', () => {
    expect(resolveFileStorage(config(), S3_ENV)).toEqual({
      backend: 's3',
      endpoint: 'https://account.r2.example.com',
      bucket: 'podium-files',
      region: 'auto',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-value-never-quoted',
    })
  })

  it('takes the bucket from config.json and only the key pair from the environment', () => {
    const fromFile = config({
      backend: 's3',
      endpoint: 'https://s3.us-east-1.amazonaws.com/',
      bucket: 'files.example',
      region: 'us-east-1',
    })
    expect(resolveFileStorage(fromFile, KEYS)).toEqual({
      backend: 's3',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      bucket: 'files.example',
      region: 'us-east-1',
      ...{ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-value-never-quoted' },
    })
  })

  it('lets each variable override its own config field', () => {
    const fromFile = config({
      backend: 'local',
      endpoint: 'https://file.example.com',
      bucket: 'file-bucket',
      region: 'file-region',
    })
    const resolved = resolveFileStorage(fromFile, {
      PODIUM_FILE_STORAGE_BACKEND: 's3',
      PODIUM_FILE_STORAGE_BUCKET: 'env-bucket',
      ...KEYS,
    })
    expect(resolved).toMatchObject({
      backend: 's3',
      endpoint: 'https://file.example.com',
      bucket: 'env-bucket',
      region: 'file-region',
    })
  })

  it('lets the environment choose local over a file that says s3', () => {
    const fromFile = config({ backend: 's3' })
    expect(resolveFileStorage(fromFile, { PODIUM_FILE_STORAGE_BACKEND: 'local' })).toEqual({
      backend: 'local',
    })
  })

  it('allows plain http only on a loopback endpoint', () => {
    expect(
      resolveFileStorage(config(), {
        ...S3_ENV,
        PODIUM_FILE_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      }),
    ).toMatchObject({ endpoint: 'http://127.0.0.1:9000' })
    expect(
      failure(() =>
        resolveFileStorage(config(), {
          ...S3_ENV,
          PODIUM_FILE_STORAGE_ENDPOINT: 'http://minio.example:9000',
        }),
      ),
    ).toMatch(/PODIUM_FILE_STORAGE_ENDPOINT must use https:\/\/ unless the host is loopback/)
  })

  it('refuses an endpoint with a path, credentials or an unknown scheme', () => {
    for (const [endpoint, pattern] of [
      ['https://r2.example.com/bucket', /bare origin/],
      ['https://user:pass@r2.example.com', /must not carry credentials/],
      ['ftp://r2.example.com', /must start with https/],
      ['not a url', /not a valid URL/],
    ] as const) {
      expect(
        failure(() =>
          resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_ENDPOINT: endpoint }),
        ),
        endpoint,
      ).toMatch(pattern)
    }
  })

  it('names every missing s3 field and where to set it', () => {
    const { PODIUM_FILE_STORAGE_BUCKET: _bucket, ...withoutBucket } = S3_ENV
    expect(failure(() => resolveFileStorage(config(), withoutBucket))).toBe(
      'file storage is misconfigured: the s3 backend needs bucket: set PODIUM_FILE_STORAGE_BUCKET or config.fileStorage.bucket',
    )
    const {
      PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY: _secret,
      PODIUM_FILE_STORAGE_ACCESS_KEY_ID: _id,
      ...withoutKeys
    } = S3_ENV
    expect(failure(() => resolveFileStorage(config(), withoutKeys))).toBe(
      'file storage is misconfigured: the s3 backend needs its key pair from the environment: set PODIUM_FILE_STORAGE_ACCESS_KEY_ID and PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY',
    )
    expect(
      failure(() => resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_REGION: '  ' })),
    ).toMatch(/needs region/)
  })

  it('refuses a bucket name or region the provider would reject', () => {
    expect(
      failure(() =>
        resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_BUCKET: 'Upper_Case' }),
      ),
    ).toMatch(/PODIUM_FILE_STORAGE_BUCKET is not an S3 bucket name/)
    expect(
      failure(() =>
        resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_REGION: 'us east' }),
      ),
    ).toMatch(/PODIUM_FILE_STORAGE_REGION is not a region/)
  })

  it('refuses an unknown backend, naming the accepted values', () => {
    expect(
      failure(() => resolveFileStorage(config(), { PODIUM_FILE_STORAGE_BACKEND: 'gcs' })),
    ).toBe('PODIUM_FILE_STORAGE_BACKEND is invalid: expected one of local, s3, got "gcs"')
    expect(() => config({ backend: 'gcs' as 'local' })).toThrow()
  })

  it('refuses bucket settings or keys while the backend is local, rather than ignoring them', () => {
    const { PODIUM_FILE_STORAGE_BACKEND: _backend, ...withoutBackend } = S3_ENV
    const message = failure(() => resolveFileStorage(config(), withoutBackend))
    expect(message).toBe(
      'file storage is misconfigured: PODIUM_FILE_STORAGE_ENDPOINT, PODIUM_FILE_STORAGE_BUCKET, PODIUM_FILE_STORAGE_REGION, PODIUM_FILE_STORAGE_ACCESS_KEY_ID, PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY are set but the backend is local; set PODIUM_FILE_STORAGE_BACKEND=s3 (or config.fileStorage.backend) or unset them',
    )
    expect(
      failure(() => resolveFileStorage(config({ backend: 'local', bucket: 'b-1' }), {})),
    ).toMatch(/config\.fileStorage\.bucket is set but the backend is local/)
  })

  it('never quotes the secret key in a refusal', () => {
    const messages = [
      failure(() =>
        resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_BACKEND: 'local' }),
      ),
      failure(() => resolveFileStorage(config(), { ...S3_ENV, PODIUM_FILE_STORAGE_BUCKET: '-' })),
    ]
    for (const message of messages)
      expect(message).not.toContain(KEYS.PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY)
  })

  it('never keeps a key pair written into config.json', () => {
    const parsed = PodiumConfig.parse({
      fileStorage: { backend: 's3', bucket: 'b-1', secretAccessKey: 'leaked' },
    })
    expect(parsed.fileStorage).toEqual({ backend: 's3', bucket: 'b-1' })
  })
})
