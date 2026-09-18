/**
 * PGP encrypt/decrypt, isolated in its own file on purpose.
 *
 * n8n's verified-community-node rules forbid runtime `dependencies` in
 * package.json (see the "No external dependencies" section of
 * https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines).
 * HMAC verification (signature.ts) needs nothing beyond `node:crypto`, but
 * OpenPGP -- armor, packet framing, curve25519 ECC, session-key wrapping,
 * MDC -- is not something to reimplement by hand for a security-critical
 * path just to avoid a dependency line. `openpgp` has zero runtime
 * dependencies of its own, so bundling it is cheap and self-contained.
 *
 * The fix: `openpgp` is a devDependency only. `scripts/bundle-pgp.mjs` runs
 * after `tsc` compiles this file to `dist/nodes/shared/pgp.js`, and inlines
 * `openpgp`'s code into that one file with esbuild (--bundle), so the
 * shipped npm tarball needs nothing from `node_modules` at install time --
 * package.json's `dependencies` stays `{}`. See HANDOFF.md for the full
 * reasoning and how to double-check this before submitting for
 * verification.
 *
 * Every function here mirrors salt-agent-sdk's `crypto.ts`
 * (/Users/z1ggy/projects/salt/salt-agent-sdk/src/crypto.ts) so ciphertext
 * produced/consumed here is byte-for-byte compatible with what salt-fe and
 * every other Salt client produce.
 */
import * as openpgp from 'openpgp';

/**
 * Decrypts an armored PGP message with the agent's own private key. Salt
 * encrypts every chat message to every member's public key (including the
 * agent's own), so the agent's key is always among the recipients.
 */
export async function decryptArmoredMessage(
	armoredMessage: string,
	armoredPrivateKey: string,
	passphrase: string,
): Promise<string> {
	const privateKey = await openpgp.decryptKey({
		privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
		passphrase,
	});
	const { data } = await openpgp.decrypt({
		message: await openpgp.readMessage({ armoredMessage }),
		decryptionKeys: [privateKey],
	});
	return data as string;
}

/**
 * Encrypts plaintext to one or more armored public keys, producing a single
 * multi-recipient ciphertext -- what salt-api stores in a message's
 * `message` field.
 */
export async function encryptForRecipients(plaintext: string, armoredPublicKeys: string[]): Promise<string> {
	const keys = await Promise.all(armoredPublicKeys.map((armoredKey) => openpgp.readKey({ armoredKey })));
	const result = await openpgp.encrypt({
		message: await openpgp.createMessage({ text: plaintext }),
		encryptionKeys: keys,
	});
	return result as string;
}

/** True for a string that looks like an armored PGP message (the same
 *  sniff salt-agent-sdk uses before attempting a decrypt). */
export function looksLikePgpMessage(value: unknown): value is string {
	return typeof value === 'string' && /^-----BEGIN PGP MESSAGE/.test(value);
}

/**
 * Derives the armored public key from an armored private key. The
 * credential only asks for the private key + passphrase (that's what an
 * agent needs to decrypt), but sending a message needs the agent's OWN
 * public key too, to encrypt the sender's-own-copy the same way
 * salt-agent-sdk's `makeReply` does (see client.ts's `postMessage`
 * `senderMessage` parameter) -- deriving it here avoids asking the user to
 * paste in a THIRD value that's fully determined by the private key.
 */
export async function derivePublicKeyArmored(armoredPrivateKey: string): Promise<string> {
	const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
	return privateKey.toPublic().armor();
}

export interface GeneratedKeypair {
	publicKey: string;
	privateKey: string;
	fingerprint: string;
}

/**
 * Generates a fresh keypair on the same curve salt-fe/salt-agent-sdk use
 * (curve25519), so a key minted here is indistinguishable from one a human
 * created through the Salt UI. Not used by either node at runtime -- only
 * by tests, which need a real keypair to encrypt/decrypt against without
 * pasting a fixture private key into the repo.
 */
export async function generateKeypair(passphrase: string): Promise<GeneratedKeypair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: 'ecc',
		curve: 'curve25519',
		userIDs: [{}],
		passphrase,
		format: 'armored',
	});
	const fingerprint = await (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint();
	return { publicKey, privateKey, fingerprint };
}
