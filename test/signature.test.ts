import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../nodes/shared/signature';

const SECRET = 'test-webhook-signing-secret';
const BODY = JSON.stringify({ chat: { id: 'c1' }, message: { message_id: 1, message: 'x' } });

describe('verifySignature', () => {
	it('accepts a signature built the same way salt-api builds one', () => {
		const now = 1_758_150_000;
		const header = signPayload(SECRET, BODY, now);
		const result = verifySignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now: () => now * 1000 });
		expect(result).toEqual({ valid: true });
	});

	it('rejects a missing signature header', () => {
		const result = verifySignature({ rawBody: BODY, signatureHeader: undefined, secret: SECRET });
		expect(result.valid).toBe(false);
	});

	it('rejects a malformed signature header', () => {
		const result = verifySignature({ rawBody: BODY, signatureHeader: 'not-a-signature', secret: SECRET });
		expect(result.valid).toBe(false);
	});

	it('rejects a tampered body', () => {
		const now = 1_758_150_000;
		const header = signPayload(SECRET, BODY, now);
		const tampered = BODY.replace('x', 'y');
		const result = verifySignature({ rawBody: tampered, signatureHeader: header, secret: SECRET, now: () => now * 1000 });
		expect(result.valid).toBe(false);
	});

	it('rejects the wrong secret', () => {
		const now = 1_758_150_000;
		const header = signPayload(SECRET, BODY, now);
		const result = verifySignature({ rawBody: BODY, signatureHeader: header, secret: 'wrong-secret', now: () => now * 1000 });
		expect(result.valid).toBe(false);
	});

	it('rejects a stale signature outside the tolerance window', () => {
		const signedAt = 1_758_150_000;
		const header = signPayload(SECRET, BODY, signedAt);
		const fiveMinutesLater = (signedAt + 301) * 1000;
		const result = verifySignature({
			rawBody: BODY,
			signatureHeader: header,
			secret: SECRET,
			now: () => fiveMinutesLater,
			toleranceSeconds: 300,
		});
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toMatch(/stale/);
	});

	it('accepts a signature right at the edge of the tolerance window', () => {
		const signedAt = 1_758_150_000;
		const header = signPayload(SECRET, BODY, signedAt);
		const justInside = (signedAt + 299) * 1000;
		const result = verifySignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now: () => justInside, toleranceSeconds: 300 });
		expect(result.valid).toBe(true);
	});
});
