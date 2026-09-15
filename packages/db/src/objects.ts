/**
 * Object storage, over the S3 API.
 *
 * The target is SeaweedFS' S3 gateway, but nothing here is SeaweedFS-specific:
 * it speaks S3, so the same code runs against AWS S3, MinIO, or R2 by changing
 * the endpoint. Two options matter for a self-hosted gateway:
 *
 * - `forcePathStyle` must be on. The AWS SDK defaults to virtual-hosted style
 *   (`http://bucket.host/key`), which needs per-bucket DNS that a local
 *   SeaweedFS does not have. Path style (`http://host/bucket/key`) is what the
 *   gateway serves.
 * - `region` is required by the SDK's signer even though SeaweedFS ignores it,
 *   hence the default rather than a mandatory field.
 *
 * Nothing in the app consumes this yet — it is the storage layer, wired in
 * when a feature needs it. It is exported and tested so that wiring is a
 * one-liner rather than a rewrite.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectStoreOptions {
  /** S3 gateway endpoint, e.g. `http://localhost:8333`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Ignored by SeaweedFS, but the request signer requires a value. */
  readonly region?: string;
}

export interface PutOptions {
  readonly contentType?: string;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /**
   * A time-limited URL for a direct download, so large payloads never pass
   * through the API process.
   */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export function createObjectStore(options: ObjectStoreOptions): ObjectStore {
  const { bucket } = options;
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    async put(key, body, putOptions) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(putOptions?.contentType === undefined
            ? {}
            : { ContentType: putOptions.contentType }),
        }),
      );
    },

    async get(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (response.Body === undefined) {
          return undefined;
        }
        return await response.Body.transformToByteArray();
      } catch (error) {
        // A missing key is a normal answer, not a failure: `undefined` lets
        // the caller branch without a try/catch of its own. Every other error
        // — auth, network, a bucket that does not exist — still throws.
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (isNotFound(error)) {
          return false;
        }
        throw error;
      }
    },

    async remove(key) {
      // S3 deletes are idempotent: removing an absent key succeeds. That
      // matches what a caller wants from `remove`, so it is not special-cased.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async signedUrl(key, expiresInSeconds = 900) {
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}

/**
 * Whether an S3 error means "no such object".
 *
 * The SDK throws typed errors for `GetObject` (`NoSuchKey`) but `HeadObject`
 * has no body to parse, so it surfaces as a bare `NotFound` — and some
 * S3-compatible gateways send neither, only a 404. All three are checked.
 */
export function isNotFound(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404
  );
}
