// Single shared PrismaClient instance for the API process.
//
// The generated client lives under prisma/generated/client (gitignored) per the
// schema's `output`. A single instance avoids exhausting the DB connection pool
// in dev (tsx watch) and in serverless. Tests inject a mock instead of this.
//
// Imported through the package's `#prisma-client` subpath import (Session 13):
// a relative path would break once the code is bundled into dist/ (different
// depth), while `#…` resolves against apps/api/package.json from anywhere.
import { PrismaClient } from '#prisma-client';

export const prisma = new PrismaClient();

export type { PrismaClient };
