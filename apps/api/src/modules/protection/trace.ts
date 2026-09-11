// =============================================================================
// Forensic (per-viewer) trace codes — Session 09.
//
// Every served image carries a short opaque code in its watermark, and every
// served video hands the same kind of code to the player to overlay. A code
// found on a leaked file is looked up in the AuditLog to find who was served
// it. Two properties make this safe to burn into a file that may itself leak:
//
//   1. The code is an HMAC, keyed with WATERMARK_TRACE_SECRET, over
//      (entity id, viewer id, minute). Without the key it cannot be walked back
//      to a viewer — the AuditLog row written alongside it is the ONLY way to
//      resolve a code. No email, no user id, no substring of either, ever
//      appears in the watermark text or the code.
//
//   2. It is deterministic per (entity, viewer, minute). A client that fetches
//      the same image three times in one minute gets three identical marks, so
//      the audit trail does not fill up with distinct codes for one sitting —
//      while two different viewers of the same content get visibly different
//      codes, which is the whole point.
//
// This is the one implementation. The content module (images AND videos) and
// the generation module both call it; neither computes a code of its own.
// =============================================================================
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '../../lib/prisma.js';

/** Platform label burned next to the code (unchanged from Session 04). */
export const WATERMARK_BRAND = 'CreatorPlatform';

/**
 * 8 chars of RFC 4648 base32 = exactly 40 bits (5 HMAC bytes). Short enough to
 * read off a screenshot, long enough that a collision between two live
 * (viewer, minute) pairs on one item is negligible (2^40 space), and the
 * alphabet has no 0/O or 1/I ambiguity because 0, 1, 8 and 9 are not in it.
 */
export const TRACE_CODE_LENGTH = 8;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MINUTE_MS = 60_000;

/** Which table the entity id points at; doubles as the AuditLog `entity`. */
export type TraceEntity = 'Content' | 'GenerationJob';

export interface TraceCodeInput {
  secret: string;
  entityId: string;
  viewerId: string;
  /** Wall-clock time of the serve; truncated to the minute inside. */
  servedAt: Date;
}

/** RFC 4648 base32 (no padding) over the first `chars * 5` bits of `bytes`. */
function base32(bytes: Buffer, chars: number): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === chars) break;
  }
  return out;
}

/**
 * Pure and synchronous: HMAC-SHA256(secret, `${entityId}\n${viewerId}\n${minute}`)
 * → first 5 bytes → 8 base32 chars. `\n` separates the fields so no
 * concatenation of two ids can collide with another pair. Constant work per
 * call whatever the inputs — nothing here branches on whether this pair has
 * been served before, so timing reveals nothing about serve history.
 */
export function computeTraceCode({ secret, entityId, viewerId, servedAt }: TraceCodeInput): string {
  const minute = Math.floor(servedAt.getTime() / MINUTE_MS);
  const digest = createHmac('sha256', secret)
    .update(`${entityId}\n${viewerId}\n${minute}`)
    .digest();
  return base32(digest, TRACE_CODE_LENGTH);
}

/** The full watermark text: brand + code. This is the ONLY text that is rendered. */
export function traceWatermarkLabel(traceCode: string): string {
  return `${WATERMARK_BRAND} • ${traceCode}`;
}

export interface IssuedTrace {
  traceCode: string;
  servedAt: Date;
}

export interface TraceRecorderDeps {
  prisma: PrismaClient;
  /** WATERMARK_TRACE_SECRET — validated (min 32 chars) at boot by env.ts. */
  secret: string;
  /** Injectable clock, so tests can pin two serves to the same minute. */
  now?: () => Date;
}

/**
 * Mint a trace code for one serve and write the AuditLog row that makes it
 * resolvable. The row is awaited, not fire-and-forget: it is the lookup table
 * that turns "this code is on a leaked screenshot" into "this viewer", and a
 * lost row is a dead end. One row per serve, even when the code repeats within
 * the minute — the trail records serves, the code de-duplicates the marks.
 *
 * The audit row reuses the existing `AuditLog` model (actorId = viewer,
 * entity/entityId = what was served, metadata carries the code) rather than a
 * parallel table: the forensic lookup is `metadata.traceCode = ?`, a rare
 * manual query that does not justify its own schema, and every other
 * "who did what" record in this codebase already lives there.
 */
export function createTraceRecorder({ prisma, secret, now = () => new Date() }: TraceRecorderDeps) {
  return {
    async issue(params: {
      entity: TraceEntity;
      entityId: string;
      viewerId: string;
    }): Promise<IssuedTrace> {
      const servedAt = now();
      const traceCode = computeTraceCode({
        secret,
        entityId: params.entityId,
        viewerId: params.viewerId,
        servedAt,
      });
      await prisma.auditLog.create({
        data: {
          actorId: params.viewerId,
          action: params.entity === 'Content' ? 'content.served' : 'generation.image_served',
          entity: params.entity,
          entityId: params.entityId,
          metadata: { viewerId: params.viewerId, traceCode, servedAt: servedAt.toISOString() },
        },
      });
      return { traceCode, servedAt };
    },
  };
}

export type TraceRecorder = ReturnType<typeof createTraceRecorder>;
