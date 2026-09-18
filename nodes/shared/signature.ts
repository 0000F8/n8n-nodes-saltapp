/**
 * Verifies the HMAC signature salt-api puts on every webhook callback.
 *
 * This is a plain reimplementation of salt-agent-sdk's `webhook.ts`
 * `rejectionReason()` (see /Users/z1ggy/projects/salt/salt-agent-sdk/src/webhook.ts)
 * and matches salt-api's own signer byte-for-byte
 * (app/jobs/application_job.rb): `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`,
 * carried as `X-Salt-Signature: t=<unix seconds>,v1=<hex digest>` alongside
 * `X-Salt-Agent-Id` and an optional `X-Salt-Delivery-Id`.
 *
 * Deliberately built on Node's built-in `node:crypto` only -- HMAC-SHA256
 * needs no third-party library, so this file carries zero runtime
 * dependencies. See HANDOFF.md for why the PGP half of this package (which
 * genuinely cannot be hand-rolled safely) is bundled instead.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_RE = /^t=(\d+),v1=([0-9a-f]+)$/;

export interface SignatureVerificationInput {
	/** The exact raw request body bytes, as a UTF-8 string. Re-serializing a
	 *  parsed object will not do -- the signature covers the bytes salt-api
	 *  actually sent, and JSON key order/whitespace/number formatting can
	 *  differ from a re-stringified copy. */
	rawBody: string;
	/** The `X-Salt-Signature` header value, e.g. "t=1758150000,v1=abcdef...". */
	signatureHeader: string | undefined;
	/** The webhook signing secret for the recipient agent (see
	 *  `GET /api/v1/agents/webhook_secret`). */
	secret: string;
	/** Reject a signature older (or newer, for clock skew) than this many
	 *  seconds. Defaults to 300, the same tolerance salt-agent-sdk uses. */
	toleranceSeconds?: number;
	/** Injectable for tests; defaults to `Date.now`. */
	now?: () => number;
}

export type SignatureVerificationResult =
	| { valid: true }
	| { valid: false; reason: string };

/**
 * Returns `{valid: true}` when `rawBody` really was signed by `secret`
 * within the allowed clock tolerance, or `{valid: false, reason}` naming
 * exactly why not (missing header, malformed header, stale, or a bad
 * digest) -- never throws.
 */
export function verifySignature(input: SignatureVerificationInput): SignatureVerificationResult {
	const { rawBody, signatureHeader, secret, toleranceSeconds = 300, now = Date.now } = input;

	if (!signatureHeader) return { valid: false, reason: 'missing X-Salt-Signature header' };
	if (!secret) return { valid: false, reason: 'no webhook signing secret configured' };

	const match = SIGNATURE_RE.exec(signatureHeader.trim());
	if (!match) return { valid: false, reason: 'malformed X-Salt-Signature header' };
	const [, timestampStr, digestHex] = match;

	const age = Math.abs(Math.floor(now() / 1000) - Number(timestampStr));
	if (age > toleranceSeconds) return { valid: false, reason: `stale signature (${age}s old)` };

	const expected = createHmac('sha256', secret).update(`${timestampStr}.${rawBody}`).digest('hex');

	const a = Buffer.from(digestHex, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	// Constant-time compare: a fast string/`===` compare leaks the digest a
	// byte at a time to a timing attacker.
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'signature mismatch' };

	return { valid: true };
}

/** Builds the `X-Salt-Signature` header value the same way salt-api does.
 *  Only used by tests, to produce a genuine signature to verify against. */
export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
	const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
	return `t=${timestampSeconds},v1=${digest}`;
}
