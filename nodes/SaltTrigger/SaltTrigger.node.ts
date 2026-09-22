import type {
	IDataObject,
	IHookFunctions,
	IWebhookFunctions,
	IWebhookResponseData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { decryptArmoredMessage, looksLikePgpMessage } from '../shared/pgp';
import { decodeResumeActionId } from '../shared/resumeToken';
import { buildGetWebhookSecretRequest, buildSetCallbackRequest, buildSetDeliveryModeRequest } from '../shared/SaltApiClient';
import { verifySignature } from '../shared/signature';

/** What this trigger keeps in the workflow's own persisted static data
 *  (`getWorkflowStaticData('node')`) between activate/deactivate/webhook
 *  calls -- salt-api has no "list my registered webhooks" endpoint to read
 *  this back from (only the write-only `PATCH /api/v1/agents/callback`), so
 *  this node is its own source of truth for what it last registered. */
interface SaltTriggerStaticData {
	registeredUrl?: string;
	webhookSecret?: string;
}

interface SaltCredentials {
	host: string;
	agentId?: string;
	apiKey: string;
	pgpPrivateKey: string;
	pgpPassphrase: string;
}

type SaltEvent = 'message' | 'chatOpened' | 'cardInteraction' | 'invoicePaid';

function eventNameFor(body: IDataObject & { type?: unknown; message?: unknown }): SaltEvent | undefined {
	if (body.type === 'chat_opened') return 'chatOpened';
	if (body.type === 'card_interaction') return 'cardInteraction';
	if (body.type === 'invoice_paid') return 'invoicePaid';
	if (body.message) return 'message';
	return undefined;
}

export class SaltTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Salt Trigger',
		name: 'saltTrigger',
		icon: { light: 'file:../shared/icons/salt.svg', dark: 'file:../shared/icons/salt.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: "Starts a workflow when this agent's Salt account receives an event",
		defaults: { name: 'Salt Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'saltAppApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				// `onReceived`: acknowledge immediately, run the workflow after.
				// Salt gives an agent's webhook 20s (WEBHOOK_TIMEOUT_SECONDS) before
				// it times out and redelivers -- a workflow that calls out to an
				// LLM can easily run longer than that, and a redelivered message
				// would otherwise start a second, duplicate execution.
				responseMode: 'onReceived',
				path: 'salt-webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [
					{
						name: 'New Message',
						value: 'message',
						description: "A chat message this agent's key can decrypt, already decrypted for you",
					},
					{
						name: 'Chat Opened',
						value: 'chatOpened',
						description: 'A brand-new 1:1, or a group this agent was just added to',
					},
					{
						name: 'Card Button Tapped',
						value: 'cardInteraction',
						description:
							'A member tapped a non-payment button on a card this agent posted. Also required for "Ask a Human and Wait" resumes -- see that action\'s notice.',
					},
					{
						name: 'Invoice Paid',
						value: 'invoicePaid',
						description:
							"An invoice this agent sent was paid and chain-confirmed. Does not fire for a plain (non-invoice) payment -- salt-api has no webhook for that.",
					},
				],
				default: ['message', 'chatOpened', 'cardInteraction', 'invoicePaid'],
				description: 'Which Salt events start this workflow',
			},
		],
	};

	webhookMethods = {
		default: {
			// See the SaltTriggerStaticData comment above for why this reads
			// our OWN last-registered record rather than asking salt-api.
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as SaltTriggerStaticData;
				const expectedUrl = this.getNodeWebhookUrl('default');
				return Boolean(staticData.registeredUrl) && staticData.registeredUrl === expectedUrl;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) {
					throw new NodeOperationError(this.getNode(), "Could not determine this workflow's webhook URL");
				}

				const setCallback = buildSetCallbackRequest(webhookUrl);
				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
						method: setCallback.method,
						url: setCallback.path,
						body: setCallback.body,
						json: true,
					});
				} catch (error) {
					// The likeliest cause: Salt refused the URL because it isn't
					// public HTTPS (User#callback_must_be_safe forbids a private,
					// loopback or link-local host) -- surface that plainly rather
					// than a raw HTTP error.
					throw new NodeOperationError(
						this.getNode(),
						`Salt refused this webhook URL as this agent's callback: ${(error as Error).message}. ` +
							'It must be reachable over public HTTPS -- a local n8n instance needs a tunnel (e.g. ngrok) or n8n Cloud.',
					);
				}

				// `delivery_mode` is a separate, sticky column from the callback
				// URL (User#socket_mode?): a previous deactivation of THIS trigger
				// (see delete() below) may have switched this agent to
				// `mode: "socket"`, which would otherwise silently survive a
				// fresh, valid callback and leave Salt still not POSTing here.
				// Best-effort: an agent that was never deactivated needs no
				// change, and an older salt-api without this endpoint just
				// leaves delivery_mode alone (a blank-callback default already
				// covers most of what this matters for).
				try {
					const setMode = buildSetDeliveryModeRequest('webhook');
					await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
						method: setMode.method,
						url: setMode.path,
						body: setMode.body,
						json: true,
					});
				} catch (error) {
					// Non-fatal -- see comment above -- but surfaced, not hidden:
					// an older salt-api without this endpoint is expected and fine,
					// anything else here is worth a human noticing.
					this.logger.warn(
						`Salt Trigger: could not reset delivery mode to "webhook" on activation (continuing; this agent may stay in socket mode if it was previously deactivated): ${(error as Error).message}`,
					);
				}

				// Fetch and cache the signing secret now, so the very first
				// delivery after activation can already be verified.
				const secretSpec = buildGetWebhookSecretRequest();
				const secretResponse = (await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
					method: secretSpec.method,
					url: secretSpec.path,
					json: true,
				})) as { webhook_secret?: string };

				const staticData = this.getWorkflowStaticData('node') as SaltTriggerStaticData;
				staticData.registeredUrl = webhookUrl;
				staticData.webhookSecret = secretResponse.webhook_secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				// salt-api's agent self-service callback endpoint refuses a blank
				// value on purpose (AgentsController#set_callback: `return error if
				// url.blank?`) -- an agent can set its OWN callback but not clear
				// it, only its human owner can, from the agent's admin form. So
				// deactivating this trigger cannot un-point Salt's callback URL
				// directly -- but it CAN switch this agent to socket mode
				// (PATCH /api/v1/agents/delivery {mode: "socket"}, LANES.md's K2
				// contract), which makes Salt stop POSTing to the now-dead
				// webhook URL regardless of what `callback` still says
				// (User#socket_mode?: an explicit delivery_mode of "socket" wins
				// even with a callback configured). Without this, Salt kept
				// retrying the dead URL (AgentWebhookRetries, 3 attempts) and
				// eventually firing the owner's `agent_webhook_failing`
				// notification for a trigger that was deliberately turned off.
				// Best-effort: if the endpoint isn't deployed yet, deactivation
				// still succeeds locally, just without silencing Salt's retries.
				try {
					const setMode = buildSetDeliveryModeRequest('socket');
					await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
						method: setMode.method,
						url: setMode.path,
						body: setMode.body,
						json: true,
					});
				} catch (error) {
					// Non-fatal -- see comment above -- but surfaced, not hidden:
					// an older salt-api without this endpoint is expected and
					// fine (Salt just keeps retrying the dead URL for a while),
					// anything else here is worth a human noticing.
					this.logger.warn(
						`Salt Trigger: could not switch delivery mode to "socket" on deactivation (continuing; Salt may keep retrying the now-dead webhook URL until it gives up): ${(error as Error).message}`,
					);
				}

				const staticData = this.getWorkflowStaticData('node') as SaltTriggerStaticData;
				delete staticData.registeredUrl;
				delete staticData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const events = this.getNodeParameter('events', []) as SaltEvent[];
		const staticData = this.getWorkflowStaticData('node') as SaltTriggerStaticData;

		const req = this.getRequestObject();
		if (!req.rawBody) {
			await req.readRawBody();
		}
		const rawBody = (req.rawBody ?? Buffer.from('')).toString('utf8');
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const signatureHeader = headerValue(headers, 'x-salt-signature');

		const fetchSecret = async (): Promise<string | undefined> => {
			const spec = buildGetWebhookSecretRequest();
			const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'saltAppApi', {
				method: spec.method,
				url: spec.path,
				json: true,
			})) as { webhook_secret?: string };
			staticData.webhookSecret = response.webhook_secret;
			return response.webhook_secret;
		};

		let secret = staticData.webhookSecret;
		if (!secret) secret = await fetchSecret();

		let verification = verifySignature({ rawBody, signatureHeader, secret: secret ?? '' });
		if (!verification.valid) {
			// Could be a rotated secret (POST /api/v1/agents/:id/rotate_webhook_secret)
			// this cached copy hasn't caught up with yet -- refetch once before
			// rejecting outright.
			secret = await fetchSecret();
			verification = verifySignature({ rawBody, signatureHeader, secret: secret ?? '' });
		}
		if (!verification.valid) {
			throw new NodeOperationError(this.getNode(), `Rejected an unverifiable Salt webhook: ${verification.reason}`);
		}

		const body = this.getBodyData() as IDataObject & {
			type?: string;
			message?: IDataObject;
			chat?: IDataObject;
			chat_id?: string;
			card_id?: string;
			action_id?: string;
			user?: IDataObject;
			[key: string]: unknown;
		};

		// A card_interaction may be OUR OWN resume bridge for "Ask a Human and
		// Wait" (see resumeToken.ts) rather than a real event for this
		// workflow -- forward it to the paused execution's resumeUrl and stop,
		// win or lose, without emitting a trigger item for it.
		if (body.type === 'card_interaction') {
			const resume = decodeResumeActionId(body.action_id);
			if (resume) {
				try {
					// Deliberately UNauthenticated with the Salt credential:
					// `resumeUrl` is an n8n-internal URL (signed by n8n itself, see
					// resumeToken.ts), never a salt-api endpoint -- sending our
					// Salt api-key header to it would be both wrong and useless.
					// eslint-disable-next-line @n8n/community-nodes/no-http-request-with-manual-auth -- see comment above
					await this.helpers.httpRequest({
						method: 'POST',
						url: resume.resumeUrl,
						body: { option: resume.option, chatId: body.chat_id, cardId: body.card_id, responder: body.user },
						json: true,
					});
				} catch {
					// The paused execution may have already timed out and been
					// cleaned up by n8n -- a normal race, not a delivery failure.
				}
				return { noWebhookResponse: true };
			}
		}

		const eventName = eventNameFor(body);
		if (!eventName || !events.includes(eventName)) {
			return { noWebhookResponse: true };
		}

		if (eventName === 'message') {
			const credentials = (await this.getCredentials('saltAppApi')) as unknown as SaltCredentials;
			const ciphertext = body.message?.message;
			if (!looksLikePgpMessage(ciphertext)) {
				// A system event riding the message webhook (e.g. a status
				// change) rather than an encrypted chat message -- nothing to
				// decrypt, and not what "New Message" means here.
				return { noWebhookResponse: true };
			}
			let plaintext: string;
			try {
				plaintext = await decryptArmoredMessage(ciphertext, credentials.pgpPrivateKey, credentials.pgpPassphrase);
			} catch {
				// Genuinely shouldn't happen -- Salt only delivers to current
				// members, and every message is encrypted for every current
				// member -- but degrade gracefully rather than failing the
				// workflow on a single bad message.
				return { noWebhookResponse: true };
			}
			return {
				workflowData: [
					[
						{
							json: {
								event: 'message',
								chat: body.chat,
								message: { ...body.message, text: plaintext },
							},
						},
					],
				],
			};
		}

		if (eventName === 'chatOpened') {
			return { workflowData: [[{ json: { event: 'chatOpened', ...body } }]] };
		}

		if (eventName === 'cardInteraction') {
			return { workflowData: [[{ json: { event: 'cardInteraction', ...body } }]] };
		}

		// invoicePaid
		return { workflowData: [[{ json: { event: 'invoicePaid', ...body } }]] };
	}
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	const value = headers[name];
	return Array.isArray(value) ? value[0] : value;
}
