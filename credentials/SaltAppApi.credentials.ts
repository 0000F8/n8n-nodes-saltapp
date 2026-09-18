import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class SaltAppApi implements ICredentialType {
	name = 'saltAppApi';
	displayName = 'Salt App API';
	documentationUrl = 'https://saltapp.ai/developers';
	icon: Icon = { light: 'file:../nodes/shared/icons/salt.svg', dark: 'file:../nodes/shared/icons/salt.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'https://saltapp.ai',
			description: 'The salt-api host this agent is registered on',
		},
		{
			displayName: 'Agent ID',
			name: 'agentId',
			type: 'string',
			default: '',
			description:
				'This agent\'s own Salt user id. Not sent on every call (salt-api identifies the agent from the API key), but used to sanity-check the "X-Salt-Agent-Id" header on incoming webhooks and shown in the UI so multi-agent setups don\'t get their credentials crossed.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'This agent\'s api-key (from creating the agent, or Admin > Your agents > Rotate API Key). Sent as the "api-key" header on every request. Whoever holds this key can act as this agent: send messages, request/pay money within its spending policy, and read anything it can read.',
		},
		{
			displayName: 'Agent PGP Private Key',
			name: 'pgpPrivateKey',
			type: 'string',
			typeOptions: { password: true, rows: 6 },
			default: '',
			description:
				'The agent\'s armored PGP private key (curve25519, the same key salt-fe would have generated for it). Whoever holds this key can read this agent\'s chats -- on n8n Cloud that includes n8n. Self-host n8n if that custody boundary matters to you; see README.md.',
		},
		{
			displayName: 'PGP Passphrase',
			name: 'pgpPassphrase',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'The passphrase the private key above was generated with',
		},
		{
			displayName: 'About the webhook signing key',
			name: 'webhookSigningNotice',
			type: 'notice',
			default: '',
			description:
				'This credential deliberately has no "webhook signing secret" field. salt-agent-sdk fetches it dynamically via GET /api/v1/agents/webhook_secret using the API key above, rather than storing it statically -- see HANDOFF.md. The Salt Trigger node fetches and caches it the same way.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'api-key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.host}}',
			// Cheapest authenticated endpoint on salt-api: it's a read of the
			// agent's own row, gated only on the api-key being valid for an
			// Agent account (AgentsController#webhook_secret).
			url: '/api/v1/agents/webhook_secret',
			method: 'GET',
		},
	};
}
