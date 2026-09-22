/**
 * Request shaping for the salt-api endpoints this package talks to, kept as
 * plain, side-effect-free functions so they're unit-testable without an n8n
 * execution context (see /test/requestShaping.test.ts). The n8n node files
 * turn a `SaltRequestSpec` into a real call via
 * `this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {...})`,
 * which is where the credential's `api-key` header actually gets attached.
 *
 * Field names and endpoint shapes are read directly from salt-api's
 * controllers and salt-agent-sdk's client.ts
 * (/Users/z1ggy/projects/salt/salt-agent-sdk/src/client.ts) -- not guessed.
 *
 * `IDataObject` is imported type-only from `n8n-workflow` -- erased at
 * compile time, so this file still has zero runtime dependencies and stays
 * testable in plain Node/vitest.
 */
import type { IDataObject } from 'n8n-workflow';

export type SaltHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface SaltRequestSpec {
	method: SaltHttpMethod;
	/** Path only (no host) -- the node combines this with the credential's `host`. */
	path: string;
	body?: IDataObject;
	/** Cache-busting query param some salt-api GETs need to avoid a stale
	 *  intermediary copy (mirrors salt-agent-sdk's `?_=${Date.now()}`). */
	cacheBust?: boolean;
}

function requireNonEmpty(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${fieldName} is required`);
	}
	return value;
}

function withCacheBust(path: string, cacheBust: boolean | undefined, now: () => number = Date.now): string {
	if (!cacheBust) return path;
	const sep = path.includes('?') ? '&' : '?';
	return `${path}${sep}_=${now()}`;
}

// --- Agent self-service (trigger activation) ---

/** `GET /api/v1/agents/webhook_secret` -- read this agent's own webhook
 *  signing secret and canonical id (see AgentsController#webhook_secret). */
export function buildGetWebhookSecretRequest(): SaltRequestSpec {
	return { method: 'GET', path: withCacheBust('/api/v1/agents/webhook_secret', true) };
}

/** `PATCH /api/v1/agents/callback` -- point this agent's webhook deliveries
 *  at `webhookUrl`. salt-api refuses a blank value (AgentsController#set_callback),
 *  so there is deliberately no "clear" variant -- see HANDOFF.md. */
export function buildSetCallbackRequest(webhookUrl: string): SaltRequestSpec {
	requireNonEmpty(webhookUrl, 'webhookUrl');
	return { method: 'PATCH', path: '/api/v1/agents/callback', body: { webhook: webhookUrl } };
}

/** `PATCH /api/v1/agents/delivery {mode}` -- self-service delivery-mode
 *  switch (LANES.md's K2 socket-mode contract), same auth as
 *  buildSetCallbackRequest. Since salt-api refuses to blank the callback
 *  (see above), this is how the Salt Trigger node actually stops Salt from
 *  POSTing to a deactivated/deleted workflow's webhook URL: switch this
 *  agent to `mode: "socket"` instead of trying to clear `webhook`. An
 *  agent in socket mode with no other consumer polling
 *  `GET /api/v1/agent/updates` simply accumulates (and, after 7 days,
 *  prunes) undelivered updates rather than retrying a dead HTTP callback --
 *  see SaltTrigger.node.ts's `delete()` and HANDOFF.md. */
export function buildSetDeliveryModeRequest(mode: 'webhook' | 'socket'): SaltRequestSpec {
	return { method: 'PATCH', path: '/api/v1/agents/delivery', body: { mode } };
}

// --- Chats & messages ---

export function buildGetChatRequest(chatId: string): SaltRequestSpec {
	requireNonEmpty(chatId, 'chatId');
	return { method: 'GET', path: withCacheBust(`/api/v1/chats/${chatId}`, true) };
}

export interface PostMessageParams {
	chatId: string;
	/** Ciphertext encrypted for every recipient (built by pgp.encryptForRecipients). */
	message: string;
	/** Ciphertext encrypted for the sender's own key, so their own client can read it back. */
	senderMessage?: string;
	mentions?: string[];
	quiet?: boolean;
}

/** `POST /api/v1/messages`. */
export function buildPostMessageRequest(params: PostMessageParams): SaltRequestSpec {
	requireNonEmpty(params.chatId, 'chatId');
	requireNonEmpty(params.message, 'message');
	const body: IDataObject = { chat_id: params.chatId, message: params.message };
	if (params.senderMessage) body.sender_message = params.senderMessage;
	if (params.mentions?.length) body.mentions = params.mentions;
	if (params.quiet) body.quiet = true;
	return { method: 'POST', path: '/api/v1/messages', body };
}

// --- Cards ---

/** A card's block is JSON-shaped data (see CARD_PROTOCOL_SPEC.md), so it's
 *  just an `IDataObject` with a required `type` -- structurally compatible
 *  with the request body types below rather than fighting them with `unknown`. */
export type CardBlock = IDataObject & { type: string };

/** `POST /api/v1/cards` (see CARD_PROTOCOL_SPEC.md). */
export function buildPostCardRequest(params: { chatId: string; blocks: CardBlock[]; text: string }): SaltRequestSpec {
	requireNonEmpty(params.chatId, 'chatId');
	if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
		throw new Error('blocks must be a non-empty array');
	}
	return {
		method: 'POST',
		path: '/api/v1/cards',
		body: { chat_id: params.chatId, blocks: params.blocks, text: params.text },
	};
}

/** `PATCH /api/v1/cards/:id` -- owner-only, re-broadcasts the new blocks live. */
export function buildUpdateCardRequest(params: { cardId: string; blocks: CardBlock[] }): SaltRequestSpec {
	requireNonEmpty(params.cardId, 'cardId');
	if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
		throw new Error('blocks must be a non-empty array');
	}
	return { method: 'PATCH', path: `/api/v1/cards/${params.cardId}`, body: { blocks: params.blocks } };
}

// --- Payments (transfer_requests rail) ---

export interface RequestPaymentParams {
	chatId: string;
	receiverId: string;
	amount: string | number;
	walletId?: string;
	message?: string;
}

/** `POST /api/v1/transfer_requests` -- a plain payment request (no line items). */
export function buildRequestPaymentRequest(params: RequestPaymentParams): SaltRequestSpec {
	requireNonEmpty(params.chatId, 'chatId');
	requireNonEmpty(params.receiverId, 'receiverId');
	if (params.amount === '' || params.amount === undefined || params.amount === null) {
		throw new Error('amount is required');
	}
	const body: IDataObject = {
		chat_id: params.chatId,
		receiver_id: params.receiverId,
		amount: params.amount,
	};
	if (params.walletId) body.wallet_id = params.walletId;
	if (params.message) body.message = params.message;
	return { method: 'POST', path: '/api/v1/transfer_requests', body };
}

export interface InvoiceLineItem {
	name: string;
	qty: number;
	unit_price: string | number;
	subtotal: string | number;
	product_id?: string;
}

export interface SendInvoiceParams {
	chatId: string;
	receiverId: string;
	amount: string | number;
	lineItems: InvoiceLineItem[];
	walletId?: string;
	message?: string;
	dueAt?: string;
}

/** Line-item math salt-api itself enforces (TransferRequest validations):
 *  each item's subtotal = qty * unit_price, and the sum of subtotals =
 *  the request's total amount. Checked client-side too, so a mistake
 *  surfaces as a clear node error instead of a 422 with no context. */
export function validateLineItems(lineItems: InvoiceLineItem[], amount: string | number): void {
	if (!Array.isArray(lineItems) || lineItems.length === 0) {
		throw new Error('At least one line item is required for an invoice');
	}
	let total = 0;
	for (const item of lineItems) {
		const qty = Number(item.qty);
		const unitPrice = Number(item.unit_price);
		const subtotal = Number(item.subtotal);
		if (!Number.isFinite(qty) || !Number.isFinite(unitPrice) || !Number.isFinite(subtotal)) {
			throw new Error(`Line item "${item.name}" has a non-numeric qty/unit_price/subtotal`);
		}
		const expected = Math.round(qty * unitPrice * 1e8) / 1e8;
		const actual = Math.round(subtotal * 1e8) / 1e8;
		if (Math.abs(expected - actual) > 1e-8) {
			throw new Error(
				`Line item "${item.name}" subtotal (${item.subtotal}) does not equal qty (${item.qty}) x unit_price (${item.unit_price})`,
			);
		}
		total += subtotal;
	}
	const roundedTotal = Math.round(total * 1e8) / 1e8;
	const roundedAmount = Math.round(Number(amount) * 1e8) / 1e8;
	if (Math.abs(roundedTotal - roundedAmount) > 1e-8) {
		throw new Error(`Line items sum to ${roundedTotal} but amount is ${amount}`);
	}
}

/** `POST /api/v1/transfer_requests` with `request_type: "invoice"`. */
export function buildSendInvoiceRequest(params: SendInvoiceParams): SaltRequestSpec {
	requireNonEmpty(params.chatId, 'chatId');
	requireNonEmpty(params.receiverId, 'receiverId');
	validateLineItems(params.lineItems, params.amount);
	const body: IDataObject = {
		chat_id: params.chatId,
		receiver_id: params.receiverId,
		amount: params.amount,
		request_type: 'invoice',
		line_items: params.lineItems,
	};
	if (params.walletId) body.wallet_id = params.walletId;
	if (params.message) body.message = params.message;
	if (params.dueAt) body.due_at = params.dueAt;
	return { method: 'POST', path: '/api/v1/transfer_requests', body };
}

// --- Hand-offs (not exposed as a node operation yet, kept for completeness) ---

export function buildHandOffRequest(params: { chatId: string; toAgentId: string; reason?: string }): SaltRequestSpec {
	requireNonEmpty(params.chatId, 'chatId');
	requireNonEmpty(params.toAgentId, 'toAgentId');
	return {
		method: 'POST',
		path: `/api/v1/chats/${params.chatId}/hand_off`,
		body: { to_agent_id: params.toAgentId, reason: params.reason },
	};
}
