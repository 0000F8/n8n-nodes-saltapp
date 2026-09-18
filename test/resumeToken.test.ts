import { describe, expect, it } from 'vitest';
import { decodeResumeActionId, encodeResumeActionId } from '../nodes/shared/resumeToken';

describe('resume action id encoding', () => {
	it('round-trips a resumeUrl and option', () => {
		const encoded = encodeResumeActionId({ resumeUrl: 'https://n8n.example.com/webhook-waiting/abc123', option: 'Approve' });
		expect(decodeResumeActionId(encoded)).toEqual({
			resumeUrl: 'https://n8n.example.com/webhook-waiting/abc123',
			option: 'Approve',
		});
	});

	it('produces a different action_id for a different option on the same resumeUrl', () => {
		const resumeUrl = 'https://n8n.example.com/webhook-waiting/abc123';
		const approve = encodeResumeActionId({ resumeUrl, option: 'Approve' });
		const decline = encodeResumeActionId({ resumeUrl, option: 'Decline' });
		expect(approve).not.toBe(decline);
	});

	it('returns null for an ordinary, non-resume action_id', () => {
		expect(decodeResumeActionId('ok')).toBeNull();
		expect(decodeResumeActionId('pay')).toBeNull();
	});

	it('returns null for undefined/null/malformed input rather than throwing', () => {
		expect(decodeResumeActionId(undefined)).toBeNull();
		expect(decodeResumeActionId(null)).toBeNull();
		expect(decodeResumeActionId('saltn8nresume:not-valid-base64url-json!!!')).toBeNull();
	});

	it('requires a resumeUrl to encode', () => {
		expect(() => encodeResumeActionId({ resumeUrl: '', option: 'x' })).toThrow();
	});
});
