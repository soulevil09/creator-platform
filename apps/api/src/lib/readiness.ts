// =============================================================================
// Readiness check (Session 13, D5).
//
// `GET /health` is liveness: the process answers, nothing else is touched.
// `GET /health/ready` is readiness: can this instance reach its database right
// now? One `SELECT 1`, bounded by a timeout, reduced to a boolean. The caller
// learns "ok" or "unavailable" and nothing more — never the error text, the
// database host, a version or a latency that would help someone fingerprint it.
// =============================================================================

/** The one Prisma capability readiness needs; tests pass a stub. */
export interface ReadinessDb {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** Deploys and the smoke test wait on this; 2 s is far above a healthy RTT. */
export const READINESS_TIMEOUT_MS = 2_000;

/** True when `SELECT 1` succeeds within `timeoutMs`; false on error or timeout. */
export async function databaseReady(
  db: ReadinessDb,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([db.$queryRaw`SELECT 1`.then(() => true as const), timedOut]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
