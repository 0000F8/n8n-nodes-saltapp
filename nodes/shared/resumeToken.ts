/**
 * The bridge between Salt's card_interaction webhook (which always calls a
 * SINGLE agent-wide callback URL -- see AgentsController#set_callback) and
 * n8n's per-EXECUTION `$execution.resumeUrl` (which is how a specific
 * paused workflow is resumed).
 *
 * Salt has no native "this button resumes this specific waiting workflow"
 * concept the way some chat platforms' interactivity payloads carry opaque
 * per-message state. So the "Ask a human and wait" action node (Salt.node.ts)
 * encodes {resumeUrl, option} into the tapped button's own `action_id` --
 * a plain string field the card_interaction webhook forwards verbatim
 * (CardsController#actions dispatches on a button's TYPE, never its label,
 * and forwards everything else's action_id/state as-is) -- and the trigger
 * node (SaltTrigger.node.ts) recognizes and decodes it, then POSTs to the
 * embedded resumeUrl itself instead of emitting a fresh trigger item.
 *
 * This means "Ask a human and wait" only actually resumes if a Salt Trigger
 * workflow is active for the same agent with "Card Button Tapped" enabled --
 * documented plainly in the node's description and in README.md/HANDOFF.md.
 *
 * Base64url-JSON rather than raw string concatenation so the encoded value
 * survives being stored in salt-api's `action_id` column and echoed back
 * through JSON without any escaping surprises.
 */

const PREFIX = 'saltn8nresume:';

export interface ResumePayload {
	resumeUrl: string;
	/** Which button the human tapped -- surfaced to the resumed workflow so
	 *  it can branch (e.g. "approve" vs "decline"). */
	option: string;
}

export function encodeResumeActionId(payload: ResumePayload): string {
	if (!payload.resumeUrl) throw new Error('resumeUrl is required to encode a resume action id');
	const json = JSON.stringify({ u: payload.resumeUrl, o: payload.option });
	return PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

/** Returns `null` for any `action_id` that isn't one of ours -- an ordinary
 *  card button from this package's "Post Card" action, or from some other
 *  agent's card entirely. Never throws: a malformed/foreign action_id is
 *  just not a resume token, not an error. */
export function decodeResumeActionId(actionId: string | undefined | null): ResumePayload | null {
	if (typeof actionId !== 'string' || !actionId.startsWith(PREFIX)) return null;
	try {
		const json = Buffer.from(actionId.slice(PREFIX.length), 'base64url').toString('utf8');
		const parsed = JSON.parse(json) as { u?: unknown; o?: unknown };
		if (typeof parsed.u !== 'string' || typeof parsed.o !== 'string') return null;
		return { resumeUrl: parsed.u, option: parsed.o };
	} catch {
		return null;
	}
}
