// =============================================================================
// In-memory WebSocket connection registry.
//
// One `Map<userId, Set<socket>>`. A user may hold several sockets at once (two
// browser tabs, a phone and a laptop), so the value is a set rather than a
// single socket — and it is capped, because an uncapped set is a memory leak an
// authenticated client can drive on its own.
//
// ── Single-instance only ────────────────────────────────────────────────────
// This map lives in one process. Fan-out therefore only reaches recipients
// connected to *this* API instance, which is correct for the MVP's
// single-instance deployment and wrong the moment the process is scaled
// horizontally. Fixing it means a shared pub/sub layer (Redis, NATS) that each
// instance subscribes to and republishes from — deliberately out of scope here
// and logged as an Open Item (Session 12/13 candidate). Nothing else in the
// messaging module depends on how fan-out is implemented: the service is handed
// a `broadcast(userId, event)` function, so swapping this for a Redis-backed
// one touches this file and the wiring in `index.ts`.
//
// Delivery is best-effort by design. A message is persisted by the REST write
// path before any broadcast is attempted, so a recipient with no socket open
// (or a socket that fails mid-send) simply reads it from history on their next
// fetch. A failed push must never fail the send that produced it.
// =============================================================================
import type { MessagingSocketEvent } from '@creator-platform/shared';

/**
 * The slice of a WebSocket this registry needs. Kept structural rather than
 * importing `ws`'s type so a test can register a plain object, and so the
 * registry has no opinion about which socket implementation is underneath.
 */
export interface BroadcastSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

/** `WebSocket.OPEN`. Hard-coded to avoid importing `ws` for one constant. */
const SOCKET_OPEN = 1;

/**
 * Concurrent sockets one account may hold. A browser tab, a phone, a spare —
 * beyond that it is abuse, and each socket is a file descriptor plus a set
 * entry that only the client decides when to release.
 */
export const MAX_CONNECTIONS_PER_USER = 3;

/** Close code sent when the cap rejects an otherwise-authenticated upgrade. */
export const CLOSE_TOO_MANY_CONNECTIONS = 4029;

export interface ConnectionRegistry {
  /**
   * Register a socket for a user. Returns false when the user is already at
   * `MAX_CONNECTIONS_PER_USER`, in which case the caller must close it.
   */
  add(userId: string, socket: BroadcastSocket): boolean;
  /** Deregister a socket. Safe to call twice (close handlers can double-fire). */
  remove(userId: string, socket: BroadcastSocket): void;
  /**
   * Push one event to every socket a user holds. The payload is serialized
   * once, not once per socket: fan-out is a string write per connection and
   * issues no database query at all.
   */
  send(userId: string, event: MessagingSocketEvent): void;
  /** How many sockets a user currently holds (used by the cap and by tests). */
  countFor(userId: string): number;
  /** Close every socket. Registered as an `onClose` hook so tests can exit. */
  closeAll(): void;
}

export function createConnectionRegistry(): ConnectionRegistry {
  const byUser = new Map<string, Set<BroadcastSocket>>();

  return {
    add(userId, socket) {
      const existing = byUser.get(userId);
      if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
        return false;
      }
      if (existing) {
        existing.add(socket);
      } else {
        byUser.set(userId, new Set([socket]));
      }
      return true;
    },

    remove(userId, socket) {
      const sockets = byUser.get(userId);
      if (!sockets) return;
      sockets.delete(socket);
      // Drop the empty set rather than leaving a per-user key behind forever.
      if (sockets.size === 0) byUser.delete(userId);
    },

    send(userId, event) {
      const sockets = byUser.get(userId);
      if (!sockets || sockets.size === 0) return;
      const payload = JSON.stringify(event);
      for (const socket of sockets) {
        if (socket.readyState !== SOCKET_OPEN) continue;
        try {
          socket.send(payload);
        } catch {
          // A dead socket must not break delivery to the rest, and must not
          // surface as a failed send: the message is already persisted.
        }
      }
    },

    countFor(userId) {
      return byUser.get(userId)?.size ?? 0;
    },

    closeAll() {
      for (const sockets of byUser.values()) {
        for (const socket of sockets) {
          try {
            socket.close(1001, 'Server shutting down');
          } catch {
            // Already gone; nothing to do.
          }
        }
      }
      byUser.clear();
    },
  };
}
