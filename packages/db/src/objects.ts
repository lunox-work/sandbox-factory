/**
 * Object storage over the S3 API: the SeaweedFS gateway locally, AWS S3 in
 * production. Only the plain object calls are used, which both answer the same
 * way, so the two differ by configuration alone. Holds uploaded avatars,
 * repository snapshots' file lists, and analysis runs' artifacts and logs.
 *
 * `forcePathStyle` must stay on: the SDK's default virtual-hosted style needs
 * per-bucket DNS that a self-hosted gateway does not have. AWS accepts path
 * style too.
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
import type { Readable } from "node:stream";

export interface ObjectStoreOptions {
  /**
   * S3 gateway endpoint, e.g. `http://localhost:8333`. Omitted, the client
   * talks to AWS S3 in `region`.
   */
  readonly endpoint?: string | undefined;
  /** Public gateway used only to sign browser downloads, e.g. localhost in Compose. */
  readonly publicEndpoint?: string | undefined;
  readonly bucket: string;
  /**
   * Static keys. Omitted, the SDK's default credential chain supplies them —
   * the ECS task role in production.
   */
  readonly credentials?:
    | { readonly accessKeyId: string; readonly secretAccessKey: string }
    | undefined;
  /** Ignored by SeaweedFS, but the request signer requires a value. */
  readonly region?: string | undefined;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** A time-limited direct-download URL, so payloads bypass the API. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Large analysis artifacts bypass whole-file buffers. Optional for legacy doubles. */
  putStream?(
    key: string,
    body: Readable,
    sizeBytes: number,
    options?: PutOptions,
  ): Promise<void>;
}

export function createObjectStore(options: ObjectStoreOptions): ObjectStore {
  const { bucket } = options;
  const config = {
    region: options.region ?? "us-east-1",
    forcePathStyle: true,
    // Older S3 gateways do not decode the SDK's optional aws-chunked checksum trailers.
    ...(options.endpoint === undefined
      ? {}
      : { requestChecksumCalculation: "WHEN_REQUIRED" as const }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          },
        }),
  };
  const client = new S3Client(config);
  const signer =
    options.publicEndpoint === undefined
      ? client
      : new S3Client({ ...config, endpoint: options.publicEndpoint });

  return {
    async putStream(key, body, sizeBytes, putOptions) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: sizeBytes,
          ...(putOptions?.contentType === undefined
            ? {}
            : { ContentType: putOptions.contentType }),
        }),
        { abortSignal: putOptions?.signal },
      );
    },
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
        signer,
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
