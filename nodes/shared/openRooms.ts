/**
 * Pure helpers for open rooms (salt-api, 2026-09-22): deciding whether a
 * chat, or an individual message inside one, is encrypted or plain text,
 * from the fields salt-api's open-rooms lane actually sends. Kept separate
 * from the node files so this branching is unit-testable without an n8n
 * execution context (see /test/openRooms.test.ts), the same reason
 * SaltApiClient.ts and pgp.ts are their own files.
 *
 * Mirrors salt-api's `Message#formatted_message` / `Chat#as_json`
 * (/Users/z1ggy/projects/salt/salt-api, branch `lane/open-rooms`):
 *
 * - `message.encrypted` (boolean) -- whether `message.message` is PGP
 *   ciphertext (true) or plain text (false). ABSENT means encrypted: every
 *   delivery before this column existed was, and an older salt-api that
 *   hasn't deployed open rooms yet never sends anything else.
 * - `message.delivered_because` ("mention" | "reply" | "keyword" | "all")
 *   -- why THIS recipient got THIS open-room delivery. Present only for an
 *   open-chat delivery; absent for every encrypted-chat delivery, which
 *   keeps exactly today's envelope shape.
 * - `chat.encrypted` / `session.encrypted` (boolean) -- same encrypted/open
 *   split, but for the chat as a whole (decided once, at creation, and
 *   never switched). Same absent-means-encrypted default.
 */
import type { IDataObject } from 'n8n-workflow';

// An intersection, not `extends IDataObject`: `message` needs to accept
// whatever an n8n item's IDataObject value actually is (including the
// non-string/PGP-armored case this module exists to branch on), and
// `interface X extends IDataObject { message?: unknown }` doesn't
// typecheck -- IDataObject's index signature requires every declared
// property to be assignable to it, which `unknown` narrows rather than
// widens.
export type OpenRoomMessage = IDataObject & {
	message?: unknown;
	encrypted?: boolean;
	delivered_because?: string;
};

/** False only when the envelope explicitly says so. */
export function isEncryptedMessage(message: OpenRoomMessage | undefined): boolean {
	return message?.encrypted !== false;
}

/** Same absent-means-encrypted rule as `isEncryptedMessage`, applied to a
 *  chat/session payload (`GET /api/v1/chats/:id`'s `session.encrypted`, or
 *  a webhook envelope's `chat.encrypted`). */
export function isEncryptedChat(chat: (IDataObject & { encrypted?: boolean }) | undefined): boolean {
	return chat?.encrypted !== false;
}

/** The open-room delivery reason, when present and a string; `undefined`
 *  for an encrypted-chat delivery or an envelope predating this field. */
export function deliveredBecause(message: OpenRoomMessage | undefined): string | undefined {
	const value = message?.delivered_because;
	return typeof value === 'string' ? value : undefined;
}

/** The plain text of an open-room message straight from the envelope --
 *  never attempt a PGP decrypt on it, it was never encrypted. `undefined`
 *  when the message isn't actually an open-room one (call `isEncryptedMessage`
 *  first, or just use this only after that check is false). */
export function openRoomText(message: OpenRoomMessage | undefined): string {
	const value = message?.message;
	return typeof value === 'string' ? value : '';
}
