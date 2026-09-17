/**
 * Object storage over the S3 API. Targets SeaweedFS' gateway but works with
 * any S3 endpoint. Not consumed by the app yet.
 *
 * `forcePathStyle` must stay on: the SDK's default virtual-hosted style needs
 * per-bucket DNS that a self-hosted gateway does not have.
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
  /** A time-limited direct-download URL, so payloads bypass the API. */
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
        // A missing key is a normal answer; every other error still throws.
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
      // S3 deletes are idempotent: removing an absent key succeeds.
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
 * Whether an S3 error means "no such object". `GetObject` throws `NoSuchKey`,
 * `HeadObject` a bare `NotFound`, and some gateways only a 404.
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
