// Regression coverage for the webhook-hardening fix: a flood of
// unauthenticated garbage POSTs to this trigger's webhook URL must never
// cost the node's Salt credential a real API call, and even a flood of
// well-formed-but-wrong signatures must be bounded to at most one
// `GET /api/v1/agents/webhook_secret` call per cooldown window.
//
// Before this fix, `webhook()` called `fetchSecret()` unconditionally on
// ANY verification failure -- including a missing/malformed/stale
// signature, which never needs a secret at all to reject -- with no
// cooldown, so every single garbage POST was one real, authenticated
// call against Salt's API. See HANDOFF.md's webhook-hardening entry and
// nodes/SaltTrigger/SaltTrigger.node.ts's `webhook()` comment.
import { describe, expect, it, vi } from 'vitest';
import { NodeOperationError } from 'n8n-workflow';
import { SaltTrigger } from '../nodes/SaltTrigger/SaltTrigger.node';
import { signPayload } from '../nodes/shared/signature';

const SECRET = 'test-webhook-signing-secret';
const FAKE_NODE = {
	id: 'test-node-id',
	name: 'Salt Trigger',
	type: 'saltTrigger',
	typeVersion: 1,
	position: [0, 0] as [number, number],
	parameters: {},
};

interface FakeContextOptions {
	staticData?: Record<string, unknown>;
	fetchSecretImpl?: () => unknown;
}

/** A minimal fake of the slice of IWebhookFunctions `webhook()` actually
 *  uses. `httpMock` is exposed so a test can assert on call count. */
function buildFakeContext(headers: Record<string, string | undefined>, rawBody: string, options: FakeContextOptions = {}) {
	const staticData = options.staticData ?? {};
	const httpMock = vi.fn(options.fetchSecretImpl ?? (() => ({ webhook_secret: SECRET })));

	const ctx = {
		getNodeParameter: (_name: string, fallback: unknown) => fallback,
		getWorkflowStaticData: () => staticData,
		getRequestObject: () => ({ rawBody: Buffer.from(rawBody, 'utf8') }),
		getHeaderData: () => headers,
		getBodyData: () => ({}),
		getCredentials: async () => ({}),
		getNode: () => FAKE_NODE,
		logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
		helpers: {
			httpRequestWithAuthentication: {
				call: async () => httpMock(),
			},
		},
	};

	return { ctx, httpMock };
}

async function callWebhook(ctx: unknown): Promise<unknown> {
	return (SaltTrigger.prototype as { webhook: (this: unknown) => Promise<unknown> }).webhook.call(ctx);
}

describe('SaltTrigger webhook: secret-fetch cost of a rejected signature', () => {
	it('spends zero network calls on a POST with no signature header at all', async () => {
		const { ctx, httpMock } = buildFakeContext({}, '{"chat_id":"c1"}', {
			staticData: { webhookSecret: SECRET },
		});

		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		expect(httpMock).not.toHaveBeenCalled();
	});

	it('spends zero network calls on a malformed signature header', async () => {
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': 'not-a-signature' }, '{"chat_id":"c1"}', {
			staticData: { webhookSecret: SECRET },
		});

		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		expect(httpMock).not.toHaveBeenCalled();
	});

	it('spends zero network calls on a wildly stale (but well-formed) signature', async () => {
		const rawBody = '{"chat_id":"c1"}';
		const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
		const header = signPayload(SECRET, rawBody, twoHoursAgo);
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': header }, rawBody, {
			staticData: { webhookSecret: SECRET },
		});

		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		expect(httpMock).not.toHaveBeenCalled();
	});

	it('repeated garbage POSTs never accumulate network calls', async () => {
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': 'garbage' }, '{}', {
			staticData: { webhookSecret: SECRET },
		});

		for (let i = 0; i < 25; i++) {
			await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		}
		expect(httpMock).not.toHaveBeenCalled();
	});

	it('a well-formed but WRONG signature refetches the secret at most once per cooldown window, not once per request', async () => {
		const rawBody = '{"chat_id":"c1"}';
		const now = Math.floor(Date.now() / 1000);
		const header = signPayload('a-completely-different-secret', rawBody, now);
		const staticData: Record<string, unknown> = { webhookSecret: SECRET };
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': header }, rawBody, {
			staticData,
			// The refetch still returns the same (still-wrong-for-this-header) secret --
			// this simulates a signature that is simply forged, not a real rotation.
			fetchSecretImpl: () => ({ webhook_secret: SECRET }),
		});

		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);
		await expect(callWebhook(ctx)).rejects.toBeInstanceOf(NodeOperationError);

		// Three rejections, but the fetch only fired once: the second and
		// third calls fall inside SECRET_FETCH_COOLDOWN_MS of the first's
		// failure and reuse the cached (still-wrong) secret instead of
		// hitting Salt's API again.
		expect(httpMock).toHaveBeenCalledTimes(1);
	});

	it('accepts a genuinely valid signature without ever needing to refetch', async () => {
		const rawBody = '{"chat_id":"c1"}';
		const now = Math.floor(Date.now() / 1000);
		const header = signPayload(SECRET, rawBody, now);
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': header }, rawBody, {
			staticData: { webhookSecret: SECRET },
		});

		const result = (await callWebhook(ctx)) as { noWebhookResponse?: boolean };
		expect(result.noWebhookResponse).toBe(true);
		expect(httpMock).not.toHaveBeenCalled();
	});

	it('a genuinely rotated secret is picked up: refetch on a wrong-but-well-formed signature can still self-heal', async () => {
		const rawBody = '{"chat_id":"c1"}';
		const now = Math.floor(Date.now() / 1000);
		const NEW_SECRET = 'rotated-secret';
		const header = signPayload(NEW_SECRET, rawBody, now);
		const { ctx, httpMock } = buildFakeContext({ 'x-salt-signature': header }, rawBody, {
			// Stale cached secret, as if this process started before the rotation.
			staticData: { webhookSecret: SECRET },
			fetchSecretImpl: () => ({ webhook_secret: NEW_SECRET }),
		});

		const result = (await callWebhook(ctx)) as { noWebhookResponse?: boolean };
		expect(result.noWebhookResponse).toBe(true);
		expect(httpMock).toHaveBeenCalledTimes(1);
	});
});
