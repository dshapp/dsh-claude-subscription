/**
 * Claude Code credential source: reading, refreshing and writing back the
 * OAuth credential that the `claude` CLI keeps for a Pro/Max/Team
 * subscription.
 *
 * Claude Code stores one JSON document, `{"claudeAiOauth": {...}}`, in the
 * macOS login keychain (generic-password item, service
 * `Claude Code-credentials`, plus a `-<sha256(configDir)[0..8]>` variant for a
 * custom `CLAUDE_CONFIG_DIR`), or in `<CLAUDE_CONFIG_DIR>/.credentials.json`
 * everywhere else. This module owns both locations so the harness can share
 * the very credential Claude Code itself uses instead of forking it.
 *
 * @module dsh-claude-subscription/claude-code
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Base keychain service name Claude Code uses for its credential item. */
export const KEYCHAIN_BASE_SERVICE = 'Claude Code-credentials';
/** Absolute path to the macOS keychain CLI, so a GUI-launched harness finds it. */
const SECURITY_BIN = '/usr/bin/security';
/** Claude Code's public OAuth client id (same value pi-ai ships). */
export const OAUTH_CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8');
/** Claude Code's OAuth token endpoint. */
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Upper bound for one token-endpoint round trip. */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Expand a leading `~` and resolve nothing else, keeping this module usable
 * from a shell-style configuration string.
 * @param value - candidate path.
 * @returns the expanded path.
 */
export function expandHome(value) {
	if (typeof value !== 'string' || value.length === 0) return value;
	if (value === '~') return homedir();
	if (value.startsWith('~/')) return join(homedir(), value.slice(2));
	return value;
}

/**
 * The Claude Code configuration directory this harness should read.
 * @param explicit - configured override, if any.
 * @returns the absolute directory.
 */
export function resolveClaudeConfigDir(explicit) {
	return expandHome(explicit && explicit.length > 0 ? explicit : process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
}

/**
 * The keychain service Claude Code derives for one configuration directory.
 * @param configDir - absolute Claude Code configuration directory.
 * @returns the hashed generic-password service name.
 */
export function keychainServiceFor(configDir) {
	return `${KEYCHAIN_BASE_SERVICE}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

/**
 * The file Claude Code uses where the keychain is not available.
 * @param configDir - absolute Claude Code configuration directory.
 * @returns the credential document path.
 */
export function credentialsFileFor(configDir) {
	return join(configDir, '.credentials.json');
}

/**
 * Normalize the OAuth half of a Claude Code credential document.
 * @param document - parsed credential document.
 * @returns the normalized OAuth fields, or `undefined` when unusable.
 */
export function readOAuthFields(document) {
	const oauth = document?.claudeAiOauth;
	if (typeof oauth !== 'object' || oauth === null) return undefined;
	if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return undefined;
	return {
		accessToken: oauth.accessToken,
		refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0 ? oauth.refreshToken : undefined,
		expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
		subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
		rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined
	};
}

/**
 * Read one keychain item's secret payload.
 * @param service - generic-password service name.
 * @param account - account name to pin, when configured.
 * @returns the raw password payload.
 */
async function readKeychain(service, account) {
	const args = ['find-generic-password', '-s', service];
	if (account && account.length > 0) args.push('-a', account);
	args.push('-w');
	const { stdout } = await run(SECURITY_BIN, args, { maxBuffer: 1 << 22 });
	return stdout;
}

/**
 * Write one keychain item's secret payload, updating the existing item in
 * place (`-U`) so its creation date and access control list survive.
 * @param service - generic-password service name.
 * @param account - account name owning the item.
 * @param value - new secret payload.
 */
async function writeKeychain(service, account, value) {
	await run(SECURITY_BIN, ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], { maxBuffer: 1 << 22 });
}

/**
 * Read the Claude Code credential, preferring the item Claude Code itself
 * maintains most recently.
 * @param options - configured overrides and the Claude Code configuration directory.
 * @param configDir - absolute Claude Code configuration directory.
 * @returns the credential and where it came from, or `undefined` when none exists.
 */
export async function readClaudeCredential(options, configDir) {
	const candidates = [];
	if (options.keychainService && options.keychainService.length > 0) {
		candidates.push({ kind: 'keychain', service: options.keychainService });
	}
	if (process.platform === 'darwin') {
		candidates.push({ kind: 'keychain', service: keychainServiceFor(configDir) });
		candidates.push({ kind: 'keychain', service: KEYCHAIN_BASE_SERVICE });
	}
	candidates.push({ kind: 'file', path: expandHome(options.credentialsFile) || credentialsFileFor(configDir) });

	const failures = [];
	for (const candidate of candidates) {
		try {
			const text = candidate.kind === 'file' ? await readFile(candidate.path, 'utf8') : await readKeychain(candidate.service, options.keychainAccount);
			let document;
			try {
				document = JSON.parse(text);
			} catch (error) {
				failures.push(`${candidate.kind === 'file' ? candidate.path : candidate.service}: ${error.message}`);
				continue;
			}
			const oauth = readOAuthFields(document);
			if (oauth === undefined) {
				failures.push(`${candidate.kind === 'file' ? candidate.path : candidate.service}: no claudeAiOauth.accessToken`);
				continue;
			}
			return {
				document,
				oauth,
				source: candidate.kind,
				path: candidate.kind === 'file' ? candidate.path : undefined,
				service: candidate.kind === 'keychain' ? candidate.service : undefined,
				account: candidate.kind === 'keychain' ? options.keychainAccount : undefined,
				text
			};
		} catch (error) {
			failures.push(`${candidate.kind === 'file' ? candidate.path : candidate.service}: ${error.message}`);
		}
	}
	return { failures };
}

/**
 * Persist a credential document back to the place it was read from, which is
 * what keeps the `claude` CLI and this harness on one rotating refresh token.
 * @param credential - a credential returned by {@link readClaudeCredential}.
 * @param document - the next credential document.
 * @param options - configured overrides.
 * @returns the locator written to.
 */
export async function writeClaudeCredential(credential, document, options) {
	const text = JSON.stringify(document);
	if (credential.source === 'file') {
		await mkdir(join(credential.path, '..'), { recursive: true, mode: 0o700 });
		await writeFile(credential.path, `${text}\n`, { mode: 0o600 });
		return credential.path;
	}
	await writeKeychain(credential.service, credential.account ?? options.keychainAccount, text);
	return credential.service;
}

/**
 * Preserve the pre-rotation credential before the first write-back, then the
 * immediately preceding one, so a bad rotation is always recoverable by hand.
 * @param credential - the credential about to be replaced.
 * @param backupDir - directory holding the backups.
 * @returns the paths written.
 */
export async function backupClaudeCredential(credential, backupDir) {
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const written = [];
	const write = async (name) => {
		const path = join(backupDir, name);
		try {
			await readFile(path, 'utf8');
			return;
		} catch {}
		await writeFile(path, `${credential.text.trim()}\n`, { mode: 0o600 });
		written.push(path);
	};
	await write('original.json');
	await writeFile(join(backupDir, 'previous.json'), `${credential.text.trim()}\n`, { mode: 0o600 });
	written.push(join(backupDir, 'previous.json'));
	return written;
}

/**
 * Exchange a refresh token for a new access token, using the same client id
 * and endpoint Claude Code uses.
 * @param oauth - current OAuth fields; `refreshToken` is required.
 * @param signal - cancellation signal.
 * @returns the rotated OAuth fields.
 * @throws when the endpoint refuses the refresh or answers unusably.
 */
export async function refreshClaudeCredential(oauth, signal) {
	if (oauth.refreshToken === undefined) throw new Error('this Claude Code credential carries no refresh token, so it cannot be renewed; run `claude` to sign in again');
	const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
	const response = await fetch(OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			grant_type: 'refresh_token',
			client_id: OAUTH_CLIENT_ID,
			refresh_token: oauth.refreshToken
		}),
		signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`Claude OAuth refresh was refused (HTTP ${response.status}): ${body.slice(0, 400)}`);
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error(`Claude OAuth refresh returned invalid JSON: ${body.slice(0, 200)}`);
	}
	if (typeof data.access_token !== 'string' || data.access_token.length === 0) throw new Error('Claude OAuth refresh returned no access_token');
	const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 8 * 60 * 60;
	return {
		accessToken: data.access_token,
		refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.length > 0 ? data.refresh_token : oauth.refreshToken,
		expiresAt: Date.now() + expiresIn * 1000,
		subscriptionType: oauth.subscriptionType,
		rateLimitTier: oauth.rateLimitTier
	};
}

/**
 * Fold rotated OAuth fields back into a credential document, leaving every
 * other field Claude Code wrote untouched.
 * @param document - the document the fields came from.
 * @param oauth - rotated fields.
 * @returns the next document.
 */
export function withOAuthFields(document, oauth) {
	const next = { ...document, claudeAiOauth: { ...document.claudeAiOauth } };
	next.claudeAiOauth.accessToken = oauth.accessToken;
	if (oauth.refreshToken !== undefined) next.claudeAiOauth.refreshToken = oauth.refreshToken;
	if (oauth.expiresAt !== undefined) next.claudeAiOauth.expiresAt = oauth.expiresAt;
	return next;
}

/**
 * Whether a credential needs renewing before it is next used.
 * @param oauth - current OAuth fields.
 * @param marginMs - how long before expiry to renew.
 * @returns true when the token is expired or inside the margin.
 */
export function needsRefresh(oauth, marginMs) {
	if (oauth.expiresAt === undefined) return false;
	return oauth.expiresAt - Date.now() <= marginMs;
}