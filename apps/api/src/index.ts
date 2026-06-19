import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { APP_NAME, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES } from '@creator-platform/shared';

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const CORS_ORIGIN = process.env.APP_URL ?? true;

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: CORS_ORIGIN });

  // Liveness/readiness probe. Real domain routes arrive from Session 02 onward.
  app.get('/health', async () => ({
    status: 'ok',
    service: APP_NAME,
    currencies: SUPPORTED_CURRENCIES,
    locales: SUPPORTED_LOCALES,
    timestamp: new Date().toISOString(),
  }));

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only boot the server when run directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  void start();
}
