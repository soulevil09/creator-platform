// Account-password hashing, shared by the auth service and the ops CLI
// (Session 13, D4). Its own module so the CLI can hash exactly like
// registration does without importing the auth service — whose email
// dependency would pull in the full API env validation.
import bcrypt from 'bcryptjs';

/** bcrypt cost for account passwords. */
export const PASSWORD_COST = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_COST);
}
