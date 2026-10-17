import { describe, expect, it, vi } from 'vitest';
import { buildPostMessageRequest } from '../nodes/shared/SaltApiClient';
import { buildSendGuard, sendEncryptedWithGuard, staleRecipientMembers } from '../nodes/shared/sendGuard';

const OWN = 'PUB-SELF';
const roster = () => [
	{ id: 'agent-1', public_key: OWN, public_fingerprint: 'fp-self' },
	{ id: 'u1', public_key: 'PUB-1', public_fingerprint: 'fp-1' },
];
const keysExcludingSelf = (m: any[]) => m.filter((x) => x.id !== 'agent-1').map((x) => x.public_key);
const stale409 = (members: unknown[]) =>
	Object.assign(new Error('409'), { httpCode: '409', context: { data: { code: 'stale_recipient_keys', members } } });

describe('buildSendGuard', () => {
	it('maps other members to fingerprints and carries the sender fingerprint', () => {
		expect(buildSendGuard(roster(), 'agent-1', OWN)).toEqual({ recipientFingerprints: { u1: 'fp-1' }, senderFingerprint: 'fp-self' });
	});
	it('finds self by its own key when no agent id is configured', () => {
		expect(buildSendGuard(roster(), '', OWN).senderFingerprint).toBe('fp-self');
	});
	it('is empty when self cannot be told apart or a fingerprint is missing', () => {
		expect(buildSendGuard(roster(), '', 'OTHER')).toEqual({});
		expect(buildSendGuard([{ id: 'agent-1', public_key: OWN }, roster()[1]], 'agent-1', OWN)).toEqual({});
	});
});

describe('buildPostMessageRequest guard fields', () => {
	it('sends recipient_fingerprints and sender_fingerprint', () => {
		const spec = buildPostMessageRequest({ chatId: 'c', message: 'M', senderMessage: 'S', recipientFingerprints: { u1: 'fp-1' }, senderFingerprint: 'fp-self' });
		expect(spec.body).toMatchObject({ recipient_fingerprints: { u1: 'fp-1' }, sender_fingerprint: 'fp-self' });
	});
});

describe('staleRecipientMembers', () => {
	it('reads the body from the shapes n8n wraps', () => {
		const body = { code: 'stale_recipient_keys', members: [{ id: 'u1' }] };
		expect(staleRecipientMembers({ context: { data: body } })).toEqual([{ id: 'u1' }]);
		expect(staleRecipientMembers({ cause: { response: { data: body } } })).toEqual([{ id: 'u1' }]);
		expect(staleRecipientMembers({ response: { body: JSON.stringify(body) } })).toEqual([{ id: 'u1' }]);
		expect(staleRecipientMembers({ context: { data: { code: 'pickup_required' } } })).toBeNull();
		expect(staleRecipientMembers(new Error('x'))).toBeNull();
	});
});

describe('sendEncryptedWithGuard', () => {
	const encrypt = async (_t: string, keys: string[]) => `cipher(${keys.join(',')})`;

	it('posts once with the guard', async () => {
		const post = vi.fn(async () => ({ id: 'm' }));
		await sendEncryptedWithGuard({ encrypt, post }, 'hi', roster(), 'agent-1', OWN, keysExcludingSelf);
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith('cipher(PUB-1)', 'cipher(PUB-SELF)', { recipientFingerprints: { u1: 'fp-1' }, senderFingerprint: 'fp-self' });
	});

	it('re-encrypts once to the keys in a stale_recipient_keys refusal', async () => {
		const post = vi
			.fn()
			.mockRejectedValueOnce(stale409([{ id: 'u1', public_key: 'PUB-1-NEW', public_fingerprint: 'fp-1-new' }]))
			.mockResolvedValueOnce({ id: 'm' });
		await sendEncryptedWithGuard({ encrypt, post }, 'hi', roster(), 'agent-1', OWN, keysExcludingSelf);
		expect(post).toHaveBeenCalledTimes(2);
		expect(post).toHaveBeenLastCalledWith('cipher(PUB-1-NEW)', 'cipher(PUB-SELF)', { recipientFingerprints: { u1: 'fp-1-new' }, senderFingerprint: 'fp-self' });
	});

	it('does not loop: a second stale refusal is thrown', async () => {
		const post = vi.fn().mockRejectedValue(stale409([{ id: 'u1', public_key: 'K', public_fingerprint: 'F' }]));
		await expect(sendEncryptedWithGuard({ encrypt, post }, 'hi', roster(), 'agent-1', OWN, keysExcludingSelf)).rejects.toThrow('409');
		expect(post).toHaveBeenCalledTimes(2);
	});

	it('does not retry other errors', async () => {
		const post = vi.fn().mockRejectedValue(Object.assign(new Error('pickup'), { context: { data: { code: 'pickup_required' } } }));
		await expect(sendEncryptedWithGuard({ encrypt, post }, 'hi', roster(), 'agent-1', OWN, keysExcludingSelf)).rejects.toThrow('pickup');
		expect(post).toHaveBeenCalledTimes(1);
	});
});
