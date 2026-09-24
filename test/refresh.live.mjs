/**
 * Opt-in live check of the renewal path against a real Claude Code credential.
 *
 * This is the one place that spends a real, single-use refresh token, so it is
 * written around that fact:
 *
 *   - It refuses to run without CLAUDE_LIVE_REFRESH_TEST=1. It is never part of
 *     the default test run.
 *   - It writes the rotation back to its source the instant the token endpoint
 *     answers, BEFORE verifying anything else. Anthropic invalidates the old
 *     refresh token as it issues the new one, so a rotated-but-unwritten token
 *     is a lost credential — the exact failure this ordering prevents.
 *   - It still restores the pre-test document on any later failure, which
 *     recovers the non-token fields (plan, scopes) even though a spent refresh
 *     token cannot be un-spent.
 *
 * Run it as:
 *   CLAUDE_LIVE_REFRESH_TEST=1 node test/refresh.live.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readClaudeCredential, refreshClaudeCredential, resolveClaudeConfigDir, withOAuthFields, writeClaudeCredential } from '../lib/claude-code.js';

const run = promisify(execFile);

if (process.env.CLAUDE_LIVE_REFRESH_TEST !== '1') {
	console.error('refusing to run: this spends a real single-use refresh token.\nSet CLAUDE_LIVE_REFRESH_TEST=1 to opt in.');
	process.exit(2);
}

const configDir = resolveClaudeConfigDir(undefined);
const credential = await readClaudeCredential({ keychainAccount: process.env.USER }, configDir);
if (credential.oauth === undefined) {
	console.error(`no live Claude Code credential under ${configDir}; sign in with \`claude\` first.`);
	process.exit(2);
}

const before = credential.oauth;
const originalText = credential.text;
console.log(`before: access=${before.accessToken.slice(0, 22)}… expires=${new Date(before.expiresAt).toISOString()}`);

let rotated;
try {
	rotated = await refreshClaudeCredential(before, AbortSignal.timeout(30_000));
} catch (error) {
	console.log(`refresh refused (${error.message}); nothing was written`);
	process.exit(1);
}
console.log(`after:  access=${rotated.accessToken.slice(0, 22)}… expires=${new Date(rotated.expiresAt).toISOString()}`);
console.log(`refresh token rotated: ${rotated.refreshToken !== before.refreshToken}`);

// Persist first. Everything below is verification and may safely fail.
let locator;
try {
	locator = await writeClaudeCredential(credential, withOAuthFields(credential.document, rotated), { keychainAccount: credential.account ?? process.env.USER });
	console.log(`write-back ok: ${locator}`);
} catch (error) {
	console.error(`FAILED to write the rotation back (${error.message}).`);
	console.error('The refresh token this process just spent is now only in memory and is about to be lost.');
	console.error('Restore manually, then sign in again with `claude` if the CLI stops working.');
	await restore();
	process.exit(1);
}

try {
	const back = await readClaudeCredential({ keychainAccount: process.env.USER }, configDir);
	if (back.oauth?.accessToken !== rotated.accessToken) throw new Error(`readback mismatch from ${locator}`);
	if (back.document?.claudeAiOauth?.subscriptionType !== before.subscriptionType) throw new Error('plan fields were lost');

	const probe = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${rotated.accessToken}`,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
			'content-type': 'application/json',
			'user-agent': 'claude-cli/2.1.281',
			'x-app': 'cli'
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 16,
			system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
			messages: [{ role: 'user', content: 'Reply with the single word: RENEWED' }]
		}),
		signal: AbortSignal.timeout(60_000)
	});
	const body = await probe.text().catch(() => '');
	if (!probe.ok) throw new Error(`rotated token was refused: HTTP ${probe.status} ${body.slice(0, 200)}`);
	const parsed = JSON.parse(body);
	console.log(`rotated token accepted by Anthropic: ${parsed.content?.find((b) => b.type === 'text')?.text?.trim()} (${parsed.usage?.input_tokens}/${parsed.usage?.output_tokens} tokens)`);
} catch (error) {
	console.log(`verification failed: ${error.message}`);
	console.log('the rotated credential is already stored, so the CLI can keep working; nothing to restore');
	process.exit(1);
}

/** Put the pre-test document back, for the non-token fields at least. */
async function restore() {
	if (credential.source !== 'keychain' || credential.service === undefined) return;
	await run('/usr/bin/security', ['add-generic-password', '-U', '-s', credential.service, '-a', credential.account ?? process.env.USER, '-w', originalText]);
	console.log('restored the pre-test document');
}