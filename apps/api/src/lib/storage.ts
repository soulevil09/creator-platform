// =============================================================================
// Object storage client (Supabase Storage, S3-compatible).
//
// SDK choice — @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner over
// @supabase/storage-js:
//   * Supabase Storage exposes an S3-compatible endpoint, so the AWS SDK works
//     against it unchanged — and the SAME code works against Cloudflare R2 or
//     plain AWS S3 if we swap providers later (CLAUDE.md "swap-readiness").
//   * `getSignedUrl` from the presigner is *local computation* (HMAC over the
//     request) — no network round-trip, satisfying the Session 03 performance
//     note that signed-URL generation must be cheap.
//   * @supabase/storage-js would couple us to one provider and route signing
//     through their API. The S3 SDK keeps the storage layer provider-agnostic
//     behind the four STORAGE_* env vars.
//
// The rest of the app depends only on the `StorageClient` interface, so tests
// inject an in-memory fake and never touch a real bucket (mirrors how the auth
// layer depends on the `Emailer` interface).
// =============================================================================
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3Url } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

export interface StorageClient {
  /** Upload an object and return the storage key it was written to. */
  uploadFile(bucket: string, key: string, buffer: Buffer, mimeType: string): Promise<string>;
  /** Mint a short-lived signed GET URL for an object. */
  getSignedUrl(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
  /** Delete an object. No-op if it does not exist. */
  deleteFile(bucket: string, key: string): Promise<void>;
}

/**
 * Build an S3-compatible storage client from the STORAGE_* env vars. Supabase's
 * S3 endpoint is path-style and region-less; `forcePathStyle: true` and a dummy
 * region keep the SDK happy against it (and R2, which behaves the same way).
 */
export function createS3StorageClient(): StorageClient {
  const s3 = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
    },
  });

  return {
    async uploadFile(bucket, key, buffer, mimeType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
      return key;
    },

    async getSignedUrl(bucket, key, expiresInSeconds) {
      return presignS3Url(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    async deleteFile(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
