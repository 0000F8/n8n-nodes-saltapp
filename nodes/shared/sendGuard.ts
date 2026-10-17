// The opt-in send guard (KEY_RESET_DESIGN.md 7). A message carries the public
// fingerprint of every key it was encrypted to; if any is out of date Salt
// answers 409 { code: "stale_recipient_keys", members: [...] } and we
// re-encrypt ONCE to the keys it sent back.

export interface GuardMember {
	id: string | number;
	public_key?: string;
	public_fingerprint?: string;
	[key: string]: unknown;
}

export interface SendGuardFields {
	recipientFingerprints?: Record<string, string>;
	senderFingerprint?: string;
}

const sameKey = (a?: string, b?: string) => !!a && !!b && a.trim() === b.trim();

/** Guard fields for a roster read at send time. Empty unless this agent can be
 *  told apart from the other members and every keyed member carries a
 *  fingerprint: a missing one must never read as a stale one. */
export function buildSendGuard(members: GuardMember[], agentId: string | undefined, ownPublicKey: string): SendGuardFields {
	const keyed = members.filter((m) => typeof m.public_key === 'string');
	const me =
		keyed.find((m) => !!agentId && String(m.id) === String(agentId)) ?? keyed.find((m) => sameKey(m.public_key, ownPublicKey));
	if (!me || !keyed.every((m) => m.public_fingerprint)) return {};
	return {
		recipientFingerprints: Object.fromEntries(
			keyed.filter((m) => m !== me).map((m) => [String(m.id), m.public_fingerprint as string]),
		),
		senderFingerprint: me.public_fingerprint as string,
	};
}

/** The current members out of a `stale_recipient_keys` refusal, or null for any other error.
 *  n8n wraps HTTP failures in several shapes, so look in each place the body can sit. */
export function staleRecipientMembers(err: unknown): GuardMember[] | null {
	const e = err as any;
	const candidates = [e?.context?.data, e?.response?.body, e?.response?.data, e?.cause?.response?.body, e?.cause?.response?.data, e?.body, e?.data];
	for (const c of candidates) {
		const body = typeof c === 'string' ? safeJson(c) : c;
		if (body && body.code === 'stale_recipient_keys') return Array.isArray(body.members) ? (body.members as GuardMember[]) : [];
	}
	return null;
}

function safeJson(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

export interface EncryptedSendDeps<R> {
	/** Armored keys to ciphertext. */
	encrypt: (text: string, keys: string[]) => Promise<string>;
	post: (message: string, senderMessage: string, guard: SendGuardFields) => Promise<R>;
}

/** Encrypt to the other members and to self, post with the guard, and on a stale
 *  refusal re-encrypt to the returned keys once. A second refusal is thrown. */
export async function sendEncryptedWithGuard<R>(
	deps: EncryptedSendDeps<R>,
	text: string,
	members: GuardMember[],
	agentId: string | undefined,
	ownPublicKey: string,
	recipientKeys: (members: GuardMember[]) => string[],
): Promise<R> {
	for (let attempt = 0; ; attempt++) {
		const keys = recipientKeys(members);
		if (keys.length === 0) throw new Error('no other member with a public key to encrypt for');
		const [message, senderMessage] = await Promise.all([deps.encrypt(text, keys), deps.encrypt(text, [ownPublicKey])]);
		try {
			return await deps.post(message, senderMessage, buildSendGuard(members, agentId, ownPublicKey));
		} catch (err) {
			const fresh = staleRecipientMembers(err);
			if (!fresh || attempt > 0) throw err;
			members = members.map((m) => {
				const f = fresh.find((x) => String(x.id) === String(m.id));
				return f ? { ...m, public_key: f.public_key ?? m.public_key, public_fingerprint: f.public_fingerprint ?? m.public_fingerprint } : m;
			});
		}
	}
}
