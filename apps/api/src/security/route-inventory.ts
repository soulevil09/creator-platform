// =============================================================================
// Route security inventory (Session 12, D3).
//
// Records, at registration time, every route the server exposes together with
// the two properties the whole API is supposed to have: is the caller
// authenticated, and is the route rate-limited. `route-inventory.test.ts`
// builds the real server and checks each entry against the explicit
// allowlists in `route-policy.ts`, so a new route that forgets either control
// fails CI by name instead of shipping.
//
// Cost: an `onRoute` hook runs once per route while the server boots. Nothing
// here is on the request path.
// =============================================================================
import type { FastifyInstance, RouteOptions } from 'fastify';

export interface RouteInventoryEntry {
  method: string;
  url: string;
  /** `authenticate` runs for this route (route-level or plugin-scoped hook). */
  authenticated: boolean;
  /** A rate limit applies (`config.rateLimit` or an `app.rateLimit()` handler). */
  rateLimited: boolean;
}

type Hook = (...args: never[]) => unknown;

/** The hook stages a pre-handler guard can sit in. */
const GUARD_STAGES = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const;

function asList(value: unknown): Hook[] {
  if (Array.isArray(value)) return value as Hook[];
  return typeof value === 'function' ? [value as Hook] : [];
}

/**
 * Plugin-scoped hooks (`app.addHook('preHandler', authenticate)` — the admin
 * plugin's pattern) are not visible on `routeOptions`. Fastify keeps them on
 * the encapsulated instance under a symbol described as `fastify.hooks`; the
 * array already includes every hook inherited from ancestor scopes. Fastify
 * only attaches them once the plugin has finished loading, so this is read at
 * `onReady`, not in `onRoute`. If a Fastify upgrade renames the symbol, this
 * throws at boot rather than silently reporting scoped routes as open.
 */
function scopedHooks(instance: object, stage: string): Hook[] {
  const symbol = Object.getOwnPropertySymbols(instance).find(
    (s) => s.description === 'fastify.hooks',
  );
  if (!symbol) {
    throw new Error('[route-inventory] cannot locate Fastify scoped hooks (fastify.hooks)');
  }
  const hooks = (instance as Record<symbol, Record<string, unknown>>)[symbol];
  return asList(hooks?.[stage]);
}

/**
 * Install the collector. Must run before any route is registered (hooks only
 * see routes declared after them). Returns the list, which is also exposed as
 * `app.routeInventory` and is complete once the server is ready.
 *
 * `app.rateLimit()` returns an anonymous closure, so the only reliable way to
 * recognise one later is to remember every handler it hands out; the
 * decorator is wrapped once here, before any plugin can call it.
 */
export function installRouteInventory(
  app: FastifyInstance,
  { authenticate }: { authenticate: Hook },
): RouteInventoryEntry[] {
  const entries: RouteInventoryEntry[] = [];
  const rateLimitHandlers = new WeakSet<object>();

  const createLimiter = app.rateLimit;
  app.rateLimit = ((...args: Parameters<typeof createLimiter>) => {
    const handler = createLimiter(...args);
    rateLimitHandlers.add(handler);
    return handler;
  }) as typeof createLimiter;

  app.decorate('routeInventory', entries);

  /** Routes seen so far, with the scope they were declared in. */
  const pending: Array<{ route: RouteOptions; url: string; scope: object }> = [];

  app.addHook('onRoute', function collect(this: FastifyInstance, route: RouteOptions) {
    // The url is copied now: for a prefixed `'/'` route Fastify reuses and
    // re-points the same options object at its trailing-slash twin.
    pending.push({ route, url: route.url, scope: this });
  });

  // Boot-time only: resolve every route's posture once all plugins (and their
  // scoped hooks) have loaded.
  app.addHook('onReady', async () => {
    entries.length = 0;
    const seen = new Set<string>();
    for (const { route, url, scope } of pending) {
      const hooks = GUARD_STAGES.flatMap((stage) => [
        ...asList((route as unknown as Record<string, unknown>)[stage]),
        ...scopedHooks(scope, stage),
      ]);
      const authenticated = hooks.includes(authenticate);
      const configLimit = (route.config as { rateLimit?: unknown } | undefined)?.rateLimit;
      const rateLimited =
        (configLimit !== undefined && configLimit !== null && configLimit !== false) ||
        hooks.some((hook) => rateLimitHandlers.has(hook));

      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // `exposeHeadRoutes` clones each GET into a HEAD with the same
        // options, so a HEAD entry can never differ from its GET — listing it
        // twice would only double every allowlist.
        if (method === 'HEAD') continue;
        // `/api/payouts` and `/api/payouts/` are one declared route (a
        // prefixed '/'); list it once, under the unslashed url.
        const canonical = url.length > 1 ? url.replace(/\/$/, '') : url;
        if (seen.has(`${method} ${canonical}`)) continue;
        seen.add(`${method} ${canonical}`);
        entries.push({ method, url: canonical, authenticated, rateLimited });
      }
    }
  });

  return entries;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every registered route with its auth/rate-limit posture (Session 12, D3). */
    routeInventory: RouteInventoryEntry[];
  }
}
