import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeApiError, NodeOperationError } from 'n8n-workflow';

import { decryptArmoredMessage, derivePublicKeyArmored, encryptForRecipients, looksLikePgpMessage } from '../shared/pgp';
import { isEncryptedChat, isEncryptedMessage, openRoomText } from '../shared/openRooms';
import { encodeResumeActionId } from '../shared/resumeToken';
import {
	buildDeleteSubscriptionRequest,
	buildGetChatRequest,
	buildGetSubscriptionRequest,
	buildPostCardRequest,
	buildPostMessageRequest,
	buildRequestPaymentRequest,
	buildSendInvoiceRequest,
	buildUpdateCardRequest,
	buildUpdateSubscriptionRequest,
	cardIdFromPostCardResponse,
	CardBlock,
	SubscriptionMode,
} from '../shared/SaltApiClient';

interface SaltCredentials {
	host: string;
	agentId?: string;
	apiKey: string;
	pgpPrivateKey: string;
	pgpPassphrase: string;
}

interface SaltChatMember {
	id: string | number;
	username?: string;
	public_key?: string;
	[key: string]: unknown;
}

async function saltRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	url: string,
	body?: IDataObject,
): Promise<IDataObject> {
	return (await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
		method,
		url,
		body,
		json: true,
	})) as IDataObject;
}

/** Every chat member's public key except the caller's own (by agentId, when
 *  the credential has one) -- what a message/card's ciphertext is addressed
 *  to. Falls back to including every member (harmless: an extra recipient
 *  just means the sender's own key can also open the same blob) when no
 *  agentId is configured. */
function recipientKeysExcludingSelf(members: SaltChatMember[], agentId: string | undefined): string[] {
	return members
		.filter((m) => (!agentId || String(m.id) !== String(agentId)) && typeof m.public_key === 'string')
		.map((m) => m.public_key as string);
}

export class Salt implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Salt',
		name: 'salt',
		icon: { light: 'file:../shared/icons/salt.svg', dark: 'file:../shared/icons/salt.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Send messages, post cards, request payments, and ask a human -- as this Salt agent',
		defaults: { name: 'Salt' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'saltAppApi', required: true }],
		// Only "Agent > Ask a Human and Wait" ever calls putExecutionToWait
		// and actually gets resumed through this -- every other
		// resource/operation ignores it. Declared unconditionally because
		// n8n ties a webhook definition to the NODE, not to whichever
		// operation happens to be selected (the same way core Wait-capable
		// nodes, e.g. Slack's "Send and Wait", always declare it).
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '',
				restartWebhook: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Card', value: 'card' },
					{ name: 'Chat', value: 'chat' },
					{ name: 'Message', value: 'message' },
					{ name: 'Payment', value: 'payment' },
				],
				default: 'message',
			},

			// --- Message ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{ name: 'Send', value: 'send', description: 'Send an encrypted message into a chat', action: 'Send a message' },
					{
						name: 'List Recent',
						value: 'list',
						description: "Get a chat's recent messages, decrypted",
						action: 'List recent messages',
					},
				],
				default: 'send',
			},
			// --- Card ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['card'] } },
				options: [
					{ name: 'Post', value: 'post', description: 'Post a new blocks card into a chat', action: 'Post a card' },
					{
						name: 'Update',
						value: 'update',
						description: "Replace an owned card's blocks (re-broadcasts live)",
						action: 'Update a card',
					},
				],
				default: 'post',
			},
			// --- Payment ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['payment'] } },
				options: [
					{
						name: 'Request Payment',
						value: 'requestPayment',
						description: 'Drop a plain payment request bubble into a chat',
						action: 'Request a payment',
					},
					{
						name: 'Send Invoice',
						value: 'sendInvoice',
						description: 'Drop an itemized invoice bubble into a chat',
						action: 'Send an invoice',
					},
				],
				default: 'requestPayment',
			},
			// --- Chat ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['chat'] } },
				options: [
					{ name: 'Get', value: 'get', description: 'Get a chat and its members', action: 'Get a chat' },
					{
						name: 'Get Interests',
						value: 'getInterests',
						description: "This agent's own follow setting for an open room",
						action: 'Get room interests',
					},
					{
						name: 'Set Interests',
						value: 'setInterests',
						description: 'Set which posts in an open room deliver to this agent',
						action: 'Set room interests',
					},
					{
						name: 'Clear Interests',
						value: 'clearInterests',
						description: "Reset this agent's open-room interests to the default (addressed)",
						action: 'Clear room interests',
					},
				],
				default: 'get',
			},
			// --- Agent ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						name: 'Ask a Human and Wait',
						value: 'askAndWait',
						description: 'Post a card with option buttons and pause the workflow until someone taps one',
						action: 'Ask a human and wait',
					},
				],
				default: 'askAndWait',
			},

			// --- Shared: Chat ID ---
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['message', 'card', 'payment', 'chat', 'agent'],
					},
				},
				description: 'The Salt chat to act in',
			},

			// --- Chat: Set Interests ---
			{
				displayName: 'Mode',
				name: 'subscriptionMode',
				type: 'options',
				options: [
					{
						name: 'Addressed to Me',
						value: 'addressed',
						description: 'Only on a mention, a reply, or a 1:1 -- the default, same as an encrypted chat always has',
					},
					{
						name: 'Keywords',
						value: 'keywords',
						description: 'Addressed to me, plus any post matching one of the given keywords',
					},
					{ name: 'Everything', value: 'all', description: 'Every post in this room' },
				],
				default: 'addressed',
				displayOptions: { show: { resource: ['chat'], operation: ['setInterests'] } },
				description:
					'Only meaningful for an open (unencrypted) room -- an encrypted chat always delivers on mention/reply/1:1 and refuses this call. See the Salt Trigger\'s "New Message" event.',
			},
			{
				displayName: 'Keywords',
				name: 'subscriptionKeywords',
				type: 'string',
				default: '',
				placeholder: 'launch,incident,deploy',
				displayOptions: { show: { resource: ['chat'], operation: ['setInterests'], subscriptionMode: ['keywords'] } },
				description:
					'Comma-separated words or @handles -- whole-word, case-insensitive match against each post in the room',
			},

			// --- Message: Send ---
			{
				displayName: 'Message',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
				description: 'Plaintext to encrypt and send. Encrypted for every current chat member plus this agent\'s own copy.',
			},
			{
				displayName: 'Mention User IDs',
				name: 'mentions',
				type: 'string',
				default: '',
				placeholder: '4f1e2a3b-...,9c8d7e6f-...',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
				description:
					'Comma-separated Salt user IDs to @mention (Salt only sees ciphertext, so an "@handle" in the text alone notifies nobody -- these IDs are what actually trigger a mention notification)',
			},

			// --- Message: List ---
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['message'], operation: ['list'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				displayOptions: { show: { resource: ['message'], operation: ['list'], returnAll: [false] } },
				description: 'Max number of results to return',
			},

			// --- Card: Post / Update ---
			{
				displayName: 'Card ID',
				name: 'cardId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['card'], operation: ['update'] } },
				description: 'The card to replace the blocks of (must be owned by this agent)',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['card'], operation: ['post'] } },
				description: "Fallback text for a client that can't render blocks",
			},
			{
				displayName: 'Blocks',
				name: 'blocks',
				type: 'json',
				required: true,
				default:
					'[\n  { "type": "section", "text": "Hello from a workflow" },\n  { "type": "actions", "buttons": [ { "type": "reply", "label": "OK", "action_id": "ok" } ] }\n]',
				displayOptions: { show: { resource: ['card'] } },
				description:
					'The card\'s block array (see CARD_PROTOCOL_SPEC.md: section / fields / image / divider / actions+buttons). A non-"pay" button\'s tap arrives back at the Salt Trigger\'s "Card Button Tapped" event with this action_id.',
			},

			// --- Payment: shared ---
			{
				displayName: 'Receiver User ID',
				name: 'receiverId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['payment'] } },
				description: 'The Salt user ID being asked to pay',
			},
			{
				displayName: 'Wallet ID',
				name: 'walletId',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['payment'] } },
				description: 'Optional: a specific wallet of this agent\'s to receive the payment. Leave blank to let Salt pick.',
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['payment'] } },
			},
			// --- Payment: Request Payment ---
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				default: '',
				placeholder: '10.00',
				displayOptions: { show: { resource: ['payment'], operation: ['requestPayment'] } },
				description: 'Human-decimal amount (e.g. "10.00"), never base units (wei/satoshis)',
			},
			// --- Payment: Send Invoice ---
			{
				displayName: 'Line Items',
				name: 'lineItems',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				required: true,
				default: {},
				placeholder: 'Add Line Item',
				displayOptions: { show: { resource: ['payment'], operation: ['sendInvoice'] } },
				options: [
					{
						displayName: 'Item',
						name: 'item',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
							{ displayName: 'Quantity', name: 'qty', type: 'number', default: 1, required: true },
							{
								displayName: 'Unit Price',
								name: 'unitPrice',
								type: 'string',
								default: '',
								required: true,
								description: 'Human-decimal price per unit, e.g. "5.00"',
							},
						],
					},
				],
				description:
					'The invoice total (Amount) is computed automatically as the sum of quantity x unit price across these items -- salt-api validates that math server-side too',
			},
			{
				displayName: 'Due At',
				name: 'dueAt',
				type: 'dateTime',
				default: '',
				displayOptions: { show: { resource: ['payment'], operation: ['sendInvoice'] } },
			},

			// --- Agent: Ask a Human and Wait ---
			{
				displayName: 'Question',
				name: 'question',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['agent'], operation: ['askAndWait'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				required: true,
				default: { option: [{ label: 'Yes' }, { label: 'No' }] },
				placeholder: 'Add Option',
				displayOptions: { show: { resource: ['agent'], operation: ['askAndWait'] } },
				options: [
					{
						displayName: 'Option',
						name: 'option',
						values: [{ displayName: 'Label', name: 'label', type: 'string', default: '', required: true }],
					},
				],
				description: 'One button per option, in order',
			},
			{
				displayName: 'Timeout (Hours)',
				name: 'timeoutHours',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 24,
				displayOptions: { show: { resource: ['agent'], operation: ['askAndWait'] } },
				description: 'Resume the workflow with "timed out" output if nobody responds within this many hours',
			},
			{
				displayName: 'This requires a Salt Trigger to be active',
				name: 'askAndWaitNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['agent'], operation: ['askAndWait'] } },
				description:
					'Salt always calls this agent\'s ONE registered callback, never a per-request URL -- so an active Salt Trigger workflow for the SAME agent, with "Card Button Tapped" enabled, is what actually delivers the tap back to this paused execution. See README.md.',
			},
		],
	};

	// This node's `webhooks` entry above is the "Ask a Human and Wait" resume
	// bridge, not a registration with a third-party service (there is
	// nothing to register: n8n mints and manages `$execution.resumeUrl`
	// itself). The core Wait node and Slack's "Send and Wait" are in the
	// same position and don't implement webhookMethods either -- these are
	// trivial no-ops purely so this community package's linter
	// (`@n8n/community-nodes/webhook-lifecycle-complete`) has something to
	// check off.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const credentials = (await this.getCredentials('saltAppApi')) as unknown as SaltCredentials;

		for (let i = 0; i < items.length; i++) {
			try {
				const json = await executeOne.call(this, resource, operation, i, credentials);
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Already a well-formed n8n error (executeOne's own validation,
				// or an HTTP call that failed) -- re-throwing it as-is keeps its
				// status code and context instead of flattening it into a new,
				// less informative NodeOperationError.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- see comment above
				if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}

	/** The resume bridge target for "Ask a Human and Wait" -- see
	 *  SaltTrigger.node.ts, which is what actually POSTs here once a
	 *  card_interaction names one of this execution's resume tokens.
	 *  Never called by Salt directly. */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData() as { option?: string; chatId?: string; cardId?: string; responder?: IDataObject };
		return {
			workflowData: [
				[
					{
						json: {
							event: 'askAndWait',
							answered: true,
							timedOut: false,
							option: body.option,
							chatId: body.chatId,
							cardId: body.cardId,
							responder: body.responder,
						},
					},
				],
			],
		};
	}
}

async function executeOne(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
	credentials: SaltCredentials,
): Promise<IDataObject> {
	if (resource === 'chat' && operation === 'get') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const spec = buildGetChatRequest(chatId);
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'chat' && operation === 'getInterests') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const spec = buildGetSubscriptionRequest(chatId);
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'chat' && operation === 'setInterests') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const mode = this.getNodeParameter('subscriptionMode', i, 'addressed') as SubscriptionMode;
		const keywordsRaw = this.getNodeParameter('subscriptionKeywords', i, '') as string;
		// Sent regardless of mode -- this is a full "set", not a partial
		// patch: switching away from "keywords" also clears any keywords a
		// previous call left behind, rather than leaving them stranded and
		// inert until "keywords" mode is picked again.
		const keywords = keywordsRaw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const spec = buildUpdateSubscriptionRequest({ chatId, mode, keywords });
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'chat' && operation === 'clearInterests') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const spec = buildDeleteSubscriptionRequest(chatId);
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'message' && operation === 'send') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const text = this.getNodeParameter('text', i) as string;
		const mentionsRaw = this.getNodeParameter('mentions', i, '') as string;
		const mentions = mentionsRaw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const chat = await saltRequest.call(this, 'GET', buildGetChatRequest(chatId).path);
		const session = (chat.session as IDataObject) ?? {};

		if (!isEncryptedChat(session)) {
			// Open room: salt-api stores this chat's messages as plain text
			// and refuses ciphertext for it (MessagesController#create) -- no
			// PGP round trip, no member public keys needed.
			const spec = buildPostMessageRequest({ chatId, message: text, mentions });
			return saltRequest.call(this, spec.method, spec.path, spec.body);
		}

		const members = (session.users ?? []) as SaltChatMember[];
		const recipientKeys = recipientKeysExcludingSelf(members, credentials.agentId);
		if (recipientKeys.length === 0) {
			throw new NodeOperationError(this.getNode(), `Chat ${chatId} has no other member with a public key to encrypt for`, {
				itemIndex: i,
			});
		}
		const ownPublicKey = await derivePublicKeyArmored(credentials.pgpPrivateKey);
		const [message, senderMessage] = await Promise.all([
			encryptForRecipients(text, recipientKeys),
			encryptForRecipients(text, [ownPublicKey]),
		]);

		const spec = buildPostMessageRequest({ chatId, message, senderMessage, mentions });
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'message' && operation === 'list') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
		const limit = this.getNodeParameter('limit', i, 50) as number;

		const chat = await saltRequest.call(this, 'GET', buildGetChatRequest(chatId).path);
		const rawMessages = (chat.messages ?? []) as IDataObject[];
		const decrypted = await Promise.all(
			rawMessages.map(async (m) => {
				if (!isEncryptedMessage(m)) {
					// Open room: already plain text, never PGP -- never attempt
					// a decrypt on it (it would just fail looksLikePgpMessage).
					return { ...m, text: openRoomText(m) };
				}
				const ciphertext = m.message;
				if (!looksLikePgpMessage(ciphertext)) return m;
				try {
					const text = await decryptArmoredMessage(ciphertext, credentials.pgpPrivateKey, credentials.pgpPassphrase);
					return { ...m, text };
				} catch {
					return { ...m, text: undefined, decryptError: 'Could not decrypt (predates this agent joining the chat?)' };
				}
			}),
		);
		const sliced = returnAll ? decrypted : decrypted.slice(-limit);
		return { chatId, messages: sliced };
	}

	if (resource === 'card' && operation === 'post') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const text = this.getNodeParameter('text', i, '') as string;
		const blocks = parseBlocks(this.getNodeParameter('blocks', i) as string, this.getNode(), i);
		const spec = buildPostCardRequest({ chatId, blocks, text });
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'card' && operation === 'update') {
		const cardId = this.getNodeParameter('cardId', i) as string;
		const blocks = parseBlocks(this.getNodeParameter('blocks', i) as string, this.getNode(), i);
		const spec = buildUpdateCardRequest({ cardId, blocks });
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'payment' && operation === 'requestPayment') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const receiverId = this.getNodeParameter('receiverId', i) as string;
		const walletId = this.getNodeParameter('walletId', i, '') as string;
		const message = this.getNodeParameter('message', i, '') as string;
		const amount = this.getNodeParameter('amount', i) as string;
		const spec = buildRequestPaymentRequest({ chatId, receiverId, amount, walletId: walletId || undefined, message: message || undefined });
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'payment' && operation === 'sendInvoice') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const receiverId = this.getNodeParameter('receiverId', i) as string;
		const walletId = this.getNodeParameter('walletId', i, '') as string;
		const message = this.getNodeParameter('message', i, '') as string;
		const dueAt = this.getNodeParameter('dueAt', i, '') as string;
		const itemsParam = this.getNodeParameter('lineItems', i, {}) as { item?: Array<{ name: string; qty: number; unitPrice: string }> };
		const rows = itemsParam.item ?? [];
		if (rows.length === 0) {
			throw new NodeOperationError(this.getNode(), 'At least one line item is required', { itemIndex: i });
		}
		// Subtotal and total are DERIVED, never typed by the user, so they can
		// never disagree with qty x unit_price (see validateLineItems).
		const lineItems = rows.map((row) => ({
			name: row.name,
			qty: row.qty,
			unit_price: row.unitPrice,
			subtotal: String(Math.round(Number(row.qty) * Number(row.unitPrice) * 1e8) / 1e8),
		}));
		const amount = lineItems.reduce((sum, item) => sum + Number(item.subtotal), 0);
		const spec = buildSendInvoiceRequest({
			chatId,
			receiverId,
			amount: String(Math.round(amount * 1e8) / 1e8),
			lineItems,
			walletId: walletId || undefined,
			message: message || undefined,
			dueAt: dueAt || undefined,
		});
		return saltRequest.call(this, spec.method, spec.path, spec.body);
	}

	if (resource === 'agent' && operation === 'askAndWait') {
		const chatId = this.getNodeParameter('chatId', i) as string;
		const question = this.getNodeParameter('question', i) as string;
		const timeoutHours = this.getNodeParameter('timeoutHours', i, 24) as number;
		const optionsParam = this.getNodeParameter('options', i, {}) as { option?: Array<{ label: string }> };
		const optionLabels = (optionsParam.option ?? []).map((o) => o.label).filter(Boolean);
		if (optionLabels.length === 0) {
			throw new NodeOperationError(this.getNode(), 'At least one option is required', { itemIndex: i });
		}

		// `$execution.resumeUrl` only exists for a REAL (saved) execution --
		// e.g. not every manual/testing context. See SaltApiClient tests and
		// README.md's "Ask a Human and Wait" section.
		const resumeUrl = this.evaluateExpression('={{$execution.resumeUrl}}', i) as string | undefined;
		if (!resumeUrl) {
			throw new NodeOperationError(
				this.getNode(),
				'No resume URL for this execution. "Ask a Human and Wait" only works in a saved (production or manual) execution, not this context.',
				{ itemIndex: i },
			);
		}

		const blocks: CardBlock[] = [
			{ type: 'section', text: question },
			{
				type: 'actions',
				buttons: optionLabels.map((label) => ({
					type: 'reply',
					label,
					action_id: encodeResumeActionId({ resumeUrl, option: label }),
				})),
			},
		];
		const postSpec = buildPostCardRequest({ chatId, blocks, text: question });
		const card = await saltRequest.call(this, postSpec.method, postSpec.path, postSpec.body);

		await this.putExecutionToWait(new Date(Date.now() + timeoutHours * 60 * 60 * 1000));

		// Only reached if nobody taps a button before the timeout above --
		// see Salt.node.ts's webhook() for the "someone answered" output.
		// `card.id` doesn't exist on this response -- see
		// cardIdFromPostCardResponse's doc comment.
		return { event: 'askAndWait', answered: false, timedOut: true, chatId, cardId: cardIdFromPostCardResponse(card), question };
	}

	throw new NodeOperationError(this.getNode(), `Unknown resource/operation: ${resource}/${operation}`, { itemIndex: i });
}

function parseBlocks(raw: string, node: INode, itemIndex: number): CardBlock[] {
	let parsed: unknown;
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch (error) {
		throw new NodeOperationError(node, `Blocks is not valid JSON: ${(error as Error).message}`, { itemIndex });
	}
	if (!Array.isArray(parsed)) {
		throw new NodeOperationError(node, 'Blocks must be a JSON array', { itemIndex });
	}
	return parsed as CardBlock[];
}
