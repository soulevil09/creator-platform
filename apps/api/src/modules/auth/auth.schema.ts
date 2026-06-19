// Request validation schemas (Zod).
//
// Deviation note: the session guidance offered either a Zod-to-JSON-schema
// bridge or manual validation. We validate manually with Zod's `safeParse`
// inside each handler — it keeps the parsed type inference at the call site and
// avoids an extra schema-conversion dependency for a handful of endpoints.
import { z } from 'zod';

// Public registration may only create `model` or `subscriber` accounts.
// `admin` is provisioned out-of-band and is rejected here with a 400.
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1, 'displayName is required').max(80),
  role: z.enum(['model', 'subscriber']),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'token is required'),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
