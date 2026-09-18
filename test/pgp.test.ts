import { describe, expect, it } from 'vitest';
import { decryptArmoredMessage, derivePublicKeyArmored, encryptForRecipients, generateKeypair, looksLikePgpMessage } from '../nodes/shared/pgp';

describe('pgp round trip', () => {
	it('encrypts for one recipient and decrypts back to the same plaintext', async () => {
		const alice = await generateKeypair('alice-passphrase');
		const plaintext = 'hello from a workflow';

		const ciphertext = await encryptForRecipients(plaintext, [alice.publicKey]);
		expect(looksLikePgpMessage(ciphertext)).toBe(true);

		const decrypted = await decryptArmoredMessage(ciphertext, alice.privateKey, 'alice-passphrase');
		expect(decrypted).toBe(plaintext);
	});

	it('encrypts one ciphertext readable by every recipient (multi-recipient blob)', async () => {
		const alice = await generateKeypair('alice-passphrase');
		const bob = await generateKeypair('bob-passphrase');
		const plaintext = 'group chat message';

		const ciphertext = await encryptForRecipients(plaintext, [alice.publicKey, bob.publicKey]);

		await expect(decryptArmoredMessage(ciphertext, alice.privateKey, 'alice-passphrase')).resolves.toBe(plaintext);
		await expect(decryptArmoredMessage(ciphertext, bob.privateKey, 'bob-passphrase')).resolves.toBe(plaintext);
	});

	it('fails to decrypt with the wrong private key', async () => {
		const alice = await generateKeypair('alice-passphrase');
		const eve = await generateKeypair('eve-passphrase');
		const ciphertext = await encryptForRecipients('secret', [alice.publicKey]);

		await expect(decryptArmoredMessage(ciphertext, eve.privateKey, 'eve-passphrase')).rejects.toThrow();
	});

	it('derives the matching public key from a private key', async () => {
		const alice = await generateKeypair('alice-passphrase');
		const derived = await derivePublicKeyArmored(alice.privateKey);
		// Round trip: encrypting for the DERIVED public key must still be
		// readable by the original private key.
		const ciphertext = await encryptForRecipients('check', [derived]);
		await expect(decryptArmoredMessage(ciphertext, alice.privateKey, 'alice-passphrase')).resolves.toBe('check');
	});
});

describe('looksLikePgpMessage', () => {
	it('rejects plain strings and non-strings', () => {
		expect(looksLikePgpMessage('hello')).toBe(false);
		expect(looksLikePgpMessage(undefined)).toBe(false);
		expect(looksLikePgpMessage(42)).toBe(false);
	});

	it('accepts an armored PGP message', () => {
		expect(looksLikePgpMessage('-----BEGIN PGP MESSAGE-----\n...')).toBe(true);
	});
});
