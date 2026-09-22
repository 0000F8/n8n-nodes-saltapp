import { describe, expect, it } from 'vitest';
import { deliveredBecause, isEncryptedChat, isEncryptedMessage, openRoomText } from '../nodes/shared/openRooms';

describe('isEncryptedMessage', () => {
	it('is true when a message explicitly says encrypted: true', () => {
		expect(isEncryptedMessage({ encrypted: true, message: '-----BEGIN PGP MESSAGE-----' })).toBe(true);
	});

	it('is false only when a message explicitly says encrypted: false', () => {
		expect(isEncryptedMessage({ encrypted: false, message: 'plain text' })).toBe(false);
	});

	it('defaults to encrypted when the field is absent -- an older salt-api, or every delivery before open rooms existed', () => {
		expect(isEncryptedMessage({ message: '-----BEGIN PGP MESSAGE-----' })).toBe(true);
	});

	it('defaults to encrypted for an undefined message object', () => {
		expect(isEncryptedMessage(undefined)).toBe(true);
	});
});

describe('isEncryptedChat', () => {
	it('is true when a chat/session explicitly says encrypted: true', () => {
		expect(isEncryptedChat({ encrypted: true })).toBe(true);
	});

	it('is false only when a chat/session explicitly says encrypted: false', () => {
		expect(isEncryptedChat({ encrypted: false })).toBe(false);
	});

	it('defaults to encrypted when the field is absent', () => {
		expect(isEncryptedChat({})).toBe(true);
		expect(isEncryptedChat(undefined)).toBe(true);
	});
});

describe('deliveredBecause', () => {
	it('returns the reason when present and a string', () => {
		expect(deliveredBecause({ delivered_because: 'mention' })).toBe('mention');
		expect(deliveredBecause({ delivered_because: 'keyword' })).toBe('keyword');
	});

	it('is undefined for an encrypted-chat delivery (field absent)', () => {
		expect(deliveredBecause({ encrypted: true })).toBeUndefined();
	});

	it('is undefined for a malformed non-string value rather than throwing', () => {
		expect(deliveredBecause({ delivered_because: 42 as unknown as string })).toBeUndefined();
	});

	it('is undefined for an undefined message object', () => {
		expect(deliveredBecause(undefined)).toBeUndefined();
	});
});

describe('openRoomText', () => {
	it('returns the plain-text message field as-is', () => {
		expect(openRoomText({ message: 'hello from an open room', encrypted: false })).toBe('hello from an open room');
	});

	it('returns an empty string rather than throwing for a missing or non-string message', () => {
		expect(openRoomText({ encrypted: false })).toBe('');
		expect(openRoomText({ message: 42 as unknown as string, encrypted: false })).toBe('');
		expect(openRoomText(undefined)).toBe('');
	});
});
