// Single shared PrismaClient instance for the API process.
//
// The generated client lives under prisma/generated/client (gitignored) per the
// schema's `output`. A single instance avoids exhausting the DB connection pool
// in dev (tsx watch) and in serverless. Tests inject a mock instead of this.
import { PrismaClient } from '../../prisma/generated/client/index.js';

export const prisma = new PrismaClient();

export type { PrismaClient };
