// Transactional email via Resend (free tier; swappable behind this interface).
//
// The rest of the app depends only on the `Emailer` interface, so tests inject a
// fake and Session 13+ can swap providers without touching auth code.
import { Resend } from 'resend';
import { env } from './env.js';

export interface Emailer {
  sendVerificationEmail(to: string, verifyToken: string): Promise<void>;
}

function verificationUrl(token: string): string {
  return `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Real Resend-backed emailer. */
export function createResendEmailer(apiKey: string = env.EMAIL_API_KEY): Emailer {
  const resend = new Resend(apiKey);
  return {
    async sendVerificationEmail(to, verifyToken) {
      const url = verificationUrl(verifyToken);
      await resend.emails.send({
        from: env.EMAIL_FROM,
        to,
        subject: 'Verify your email',
        html: `<p>Welcome to Creator Platform.</p>
<p>Confirm your email address by clicking the link below (valid for 24 hours):</p>
<p><a href="${url}">${url}</a></p>`,
      });
    },
  };
}
