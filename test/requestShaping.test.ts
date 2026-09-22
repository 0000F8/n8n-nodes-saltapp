import { describe, expect, it } from 'vitest';
import {
	buildDeleteSubscriptionRequest,
	buildGetChatRequest,
	buildGetSubscriptionRequest,
	buildGetWebhookSecretRequest,
	buildPostCardRequest,
	buildPostMessageRequest,
	buildRequestPaymentRequest,
	buildSendInvoiceRequest,
	buildSetCallbackRequest,
	buildSetDeliveryModeRequest,
	buildUpdateCardRequest,
	buildUpdateSubscriptionRequest,
	validateLineItems,
} from '../nodes/shared/SaltApiClient';

describe('buildGetWebhookSecretRequest', () => {
	it('GETs the agent-self webhook_secret endpoint with a cache-busting param', () => {
		const spec = buildGetWebhookSecretRequest();
		expect(spec.method).toBe('GET');
		expect(spec.path).toMatch(/^\/api\/v1\/agents\/webhook_secret\?_=\d+$/);
	});
});

describe('buildSetCallbackRequest', () => {
	it('PATCHes the callback with the given webhook URL', () => {
		const spec = buildSetCallbackRequest('https://n8n.example.com/webhook/abc');
		expect(spec).toEqual({
			method: 'PATCH',
			path: '/api/v1/agents/callback',
			body: { webhook: 'https://n8n.example.com/webhook/abc' },
		});
	});

	it('refuses a blank webhook URL client-side, same as salt-api', () => {
		expect(() => buildSetCallbackRequest('')).toThrow();
	});
});

describe('buildSetDeliveryModeRequest', () => {
	it('PATCHes the delivery mode to socket -- how trigger deactivation silences a dead webhook URL', () => {
		const spec = buildSetDeliveryModeRequest('socket');
		expect(spec).toEqual({
			method: 'PATCH',
			path: '/api/v1/agents/delivery',
			body: { mode: 'socket' },
		});
	});

	it('PATCHes the delivery mode to webhook -- how trigger activation resets a previously-deactivated agent', () => {
		const spec = buildSetDeliveryModeRequest('webhook');
		expect(spec).toEqual({
			method: 'PATCH',
			path: '/api/v1/agents/delivery',
			body: { mode: 'webhook' },
		});
	});
});

describe('buildGetChatRequest', () => {
	it('requires a chatId', () => {
		expect(() => buildGetChatRequest('')).toThrow();
	});

	it('builds a cache-busted GET', () => {
		const spec = buildGetChatRequest('chat-1');
		expect(spec.method).toBe('GET');
		expect(spec.path).toMatch(/^\/api\/v1\/chats\/chat-1\?_=\d+$/);
	});
});

describe('buildPostMessageRequest', () => {
	it('shapes the minimal body', () => {
		const spec = buildPostMessageRequest({ chatId: 'c1', message: 'ARMORED' });
		expect(spec).toEqual({
			method: 'POST',
			path: '/api/v1/messages',
			body: { chat_id: 'c1', message: 'ARMORED' },
		});
	});

	it('includes sender_message, mentions and quiet only when provided', () => {
		const spec = buildPostMessageRequest({
			chatId: 'c1',
			message: 'ARMORED',
			senderMessage: 'ARMORED_SELF',
			mentions: ['u1', 'u2'],
			quiet: true,
		});
		expect(spec.body).toEqual({
			chat_id: 'c1',
			message: 'ARMORED',
			sender_message: 'ARMORED_SELF',
			mentions: ['u1', 'u2'],
			quiet: true,
		});
	});

	it('requires chatId and message', () => {
		expect(() => buildPostMessageRequest({ chatId: '', message: 'x' })).toThrow();
		expect(() => buildPostMessageRequest({ chatId: 'c1', message: '' })).toThrow();
	});
});

describe('buildPostCardRequest / buildUpdateCardRequest', () => {
	it('requires a non-empty blocks array', () => {
		expect(() => buildPostCardRequest({ chatId: 'c1', blocks: [], text: 't' })).toThrow();
		expect(() => buildUpdateCardRequest({ cardId: 'card1', blocks: [] })).toThrow();
	});

	it('shapes a post', () => {
		const spec = buildPostCardRequest({ chatId: 'c1', blocks: [{ type: 'section', text: 'hi' }], text: 'hi' });
		expect(spec).toEqual({
			method: 'POST',
			path: '/api/v1/cards',
			body: { chat_id: 'c1', blocks: [{ type: 'section', text: 'hi' }], text: 'hi' },
		});
	});

	it('shapes an update as a PATCH to the card id', () => {
		const spec = buildUpdateCardRequest({ cardId: 'card1', blocks: [{ type: 'divider' }] });
		expect(spec).toEqual({ method: 'PATCH', path: '/api/v1/cards/card1', body: { blocks: [{ type: 'divider' }] } });
	});
});

describe('buildRequestPaymentRequest', () => {
	it('requires chatId, receiverId and amount', () => {
		expect(() => buildRequestPaymentRequest({ chatId: '', receiverId: 'u1', amount: '1' })).toThrow();
		expect(() => buildRequestPaymentRequest({ chatId: 'c1', receiverId: '', amount: '1' })).toThrow();
		expect(() => buildRequestPaymentRequest({ chatId: 'c1', receiverId: 'u1', amount: '' })).toThrow();
	});

	it('omits optional fields when absent', () => {
		const spec = buildRequestPaymentRequest({ chatId: 'c1', receiverId: 'u1', amount: '10.00' });
		expect(spec.body).toEqual({ chat_id: 'c1', receiver_id: 'u1', amount: '10.00' });
	});
});

describe('validateLineItems', () => {
	const goodItems = [
		{ name: 'Widget', qty: 2, unit_price: '5.00', subtotal: '10.00' },
		{ name: 'Gadget', qty: 1, unit_price: '3.50', subtotal: '3.50' },
	];

	it('accepts items whose subtotal = qty x unit_price and whose sum = amount', () => {
		expect(() => validateLineItems(goodItems, '13.50')).not.toThrow();
	});

	it('rejects a subtotal that does not equal qty x unit_price', () => {
		const bad = [{ name: 'Widget', qty: 2, unit_price: '5.00', subtotal: '9.99' }];
		expect(() => validateLineItems(bad, '9.99')).toThrow(/does not equal/);
	});

	it('rejects a sum that does not equal amount', () => {
		expect(() => validateLineItems(goodItems, '999.00')).toThrow(/Line items sum/);
	});

	it('rejects an empty line item list', () => {
		expect(() => validateLineItems([], '0')).toThrow();
	});
});

describe('buildSendInvoiceRequest', () => {
	it('validates line items and shapes the invoice body', () => {
		const spec = buildSendInvoiceRequest({
			chatId: 'c1',
			receiverId: 'u1',
			amount: '10.00',
			lineItems: [{ name: 'Widget', qty: 2, unit_price: '5.00', subtotal: '10.00' }],
		});
		expect(spec.method).toBe('POST');
		expect(spec.path).toBe('/api/v1/transfer_requests');
		expect(spec.body).toMatchObject({ request_type: 'invoice', amount: '10.00' });
	});
});

describe('buildGetSubscriptionRequest', () => {
	it('requires a chatId', () => {
		expect(() => buildGetSubscriptionRequest('')).toThrow();
	});

	it('GETs the chat subscription endpoint', () => {
		expect(buildGetSubscriptionRequest('c1')).toEqual({
			method: 'GET',
			path: '/api/v1/chats/c1/subscription',
		});
	});
});

describe('buildUpdateSubscriptionRequest', () => {
	it('requires a chatId', () => {
		expect(() => buildUpdateSubscriptionRequest({ chatId: '', mode: 'all' })).toThrow();
	});

	it('PUTs mode and keywords together', () => {
		const spec = buildUpdateSubscriptionRequest({ chatId: 'c1', mode: 'keywords', keywords: ['launch', '@ada'] });
		expect(spec).toEqual({
			method: 'PUT',
			path: '/api/v1/chats/c1/subscription',
			body: { mode: 'keywords', keywords: ['launch', '@ada'] },
		});
	});

	it('sends an empty keywords array rather than omitting it -- this is a full set, not a partial patch', () => {
		const spec = buildUpdateSubscriptionRequest({ chatId: 'c1', mode: 'addressed', keywords: [] });
		expect(spec.body).toEqual({ mode: 'addressed', keywords: [] });
	});

	it('omits mode/keywords entirely when neither is given', () => {
		const spec = buildUpdateSubscriptionRequest({ chatId: 'c1' });
		expect(spec.body).toEqual({});
	});
});

describe('buildDeleteSubscriptionRequest', () => {
	it('requires a chatId', () => {
		expect(() => buildDeleteSubscriptionRequest('')).toThrow();
	});

	it('DELETEs the chat subscription endpoint', () => {
		expect(buildDeleteSubscriptionRequest('c1')).toEqual({
			method: 'DELETE',
			path: '/api/v1/chats/c1/subscription',
		});
	});
});
