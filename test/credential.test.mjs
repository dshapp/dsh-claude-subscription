/**
 * Scratch harness for dsh-claude-subscription's credential layer. Reads the
 * real Claude Code credential, exercises the write/backup paths against a
 * throwaway keychain item, and proves the plugin's reconcile logic against a
 * stub context. Nothing here touches the real credential except reads.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
	backupClaudeCredential,
	keychainServiceFor,
	needsRefresh,
	readClaudeCredential,
	refreshClaudeCredential,
	resolveClaudeConfigDir,
	withOAuthFields,
	writeClaudeCredential
} from '../lib/claude-code.js';
import { ensureProvider, resolveOptions, syncCredential } from '../lib/index.js';

const run = promisify(execFile);
const SCRATCH = 'dsh-claude-subscription-scratch';
const results = [];
const check = (label, ok, detail = '') => {
	results.push({ label, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
/** Show just enough of a secret to tell two apart, never enough to reuse. */
const maskFor = (value) => (typeof value === 'string' && value.length > 0 ? `${value.slice(0, 16)}…` : '(none)');

// 1. the derived keychain service is stable for a given config directory.
check('keychainServiceFor is deterministic', keychainServiceFor('/tmp/x') === keychainServiceFor('/tmp/x') && keychainServiceFor('/tmp/x') !== keychainServiceFor('/tmp/y'), keychainServiceFor('/tmp/x'));

// 2. reading the real credential (read-only).
const configDir = resolveClaudeConfigDir(undefined);
const credential = await readClaudeCredential({}, configDir);
check('readClaudeCredential finds a keychain credential', credential.oauth !== undefined, credential.oauth === undefined ? JSON.stringify(credential.failures) : `${credential.service}, plan=${credential.oauth.subscriptionType}, expires=${new Date(credential.oauth.expiresAt).toISOString()}`);
if (credential.oauth === undefined) {
	console.error(
		'\nThis suite needs a live Claude Code credential to describe, and there is none on this machine.\n' +
			'Signed out? Run `claude` once and sign in, then re-run this file.\n' +
			'Refusing to continue: every later check writes to the keychain.'
	);
	process.exit(2);
}
check('credential carries a refresh token', typeof credential.oauth?.refreshToken === 'string' && credential.oauth.refreshToken.length > 0);

// 3. refresh math.
const now = Date.now();
check('needsRefresh false for a fresh token', needsRefresh({ expiresAt: now + 3600_000 }, 300_000) === false);
check('needsRefresh true inside the margin', needsRefresh({ expiresAt: now + 60_000 }, 300_000) === true);
check('needsRefresh true for an expired token', needsRefresh({ expiresAt: now - 1 }, 300_000) === true);
check('needsRefresh false when expiry is unknown', needsRefresh({}, 300_000) === false);

// 4. write/backup round trip against a throwaway keychain item.
//
// The scratch credential MUST NOT carry the live refresh token. A refresh token
// is single-use: Anthropic rotates it, and any pass that spends the real one
// invalidates the credential the `claude` CLI depends on. This suite therefore
// rewrites BOTH secret fields to synthetic values before anything here is
// allowed to write, and asserts that the substitution happened.
await run('/usr/bin/security', ['delete-generic-password', '-s', SCRATCH]).catch(() => {});
const SYNTHETIC_ACCESS = 'sk-ant-oat01-scratch-token';
const SYNTHETIC_REFRESH = 'sk-ant-ort01-scratch-token';
const scratch = { ...credential, service: SCRATCH, text: credential.text };
const rotated = withOAuthFields(credential.document, { ...credential.oauth, accessToken: SYNTHETIC_ACCESS, refreshToken: SYNTHETIC_REFRESH, expiresAt: now + 3600_000 });
check(
	'the scratch credential holds no live secret',
	rotated.claudeAiOauth.accessToken === SYNTHETIC_ACCESS && rotated.claudeAiOauth.refreshToken === SYNTHETIC_REFRESH && rotated.claudeAiOauth.refreshToken !== credential.oauth.refreshToken
);
const written = await writeClaudeCredential(scratch, rotated, { keychainAccount: 'user' });
const back = await readClaudeCredential({ keychainService: SCRATCH, keychainAccount: 'user' }, configDir);
check('writeClaudeCredential/keychain round trip', written === SCRATCH && back.oauth?.accessToken === SYNTHETIC_ACCESS, `${written}`);
check('rotation preserved untouched fields', back.document?.claudeAiOauth?.subscriptionType === credential.oauth.subscriptionType);

const backupDir = await mkdtemp(join(tmpdir(), 'claude-sub-backup-'));
const backups = await backupClaudeCredential({ ...credential, text: JSON.stringify(rotated) }, backupDir);
const original = JSON.parse(await readFile(join(backupDir, 'original.json'), 'utf8'));
check('backupClaudeCredential writes both copies', backups.length === 2 && original.claudeAiOauth.accessToken === 'sk-ant-oat01-scratch-token');

// 5. a refused refresh must fail loudly and write nothing.
let refused;
try {
	await refreshClaudeCredential({ refreshToken: 'sk-ant-ort01-not-a-real-token', subscriptionType: 'team', expiresAt: now }, undefined);
} catch (error) {
	refused = error.message;
}
check('refreshClaudeCredential surfaces a refusal', typeof refused === 'string' && refused.includes('refused'), refused?.slice(0, 120));
let noToken;
try {
	await refreshClaudeCredential({ expiresAt: now }, undefined);
} catch (error) {
	noToken = error.message;
}
check('refreshClaudeCredential refuses without a refresh token', typeof noToken === 'string' && noToken.includes('no refresh token'), noToken?.slice(0, 80));

// 6. plugin reconcile logic against stub services and the scratch credential.
const logs = [];
const refs = new Map();
const settingsWrites = [];
const stub = {
	credentials: {
		resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined),
		set: async (ref, value) => {
			refs.set(ref, value);
		}
	},
	logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
	get: (name) => (name === 'settings' ? { describe: () => [], update: async (...args) => settingsWrites.push(args) } : undefined),
	set() {},
	effect() {},
	inject() {}
};
// The bundle ships no configuration, so the fixed options are taken as-is and
// only the credential location is redirected at the scratch item. That redirect
// is what keeps this suite off the operator's live credential.
const options = { ...resolveOptions(), keychainService: SCRATCH, keychainAccount: 'user' };
check('resolveOptions fixes the route and reference', options.provider === 'anthropic' && options.apiKeyRef === 'ANTHROPIC_API_KEY' && options.displayName === 'anthropic', JSON.stringify({ provider: options.provider, ref: options.apiKeyRef, displayName: options.displayName }));

const waited = await ensureProvider(stub, options);
check('ensureProvider without a settings entry warns and declines', waited === false && logs.some(([, m]) => m.includes('no "llm-pi-ai" settings entry')));

const state = { inFlight: undefined, lastAttempt: 0 };

// Guard: `readClaudeCredential` walks a fallback chain, so a scratch service
// that is missing silently resolves the operator's live credential instead —
// and a pass that then refreshes would spend the operator's single-use refresh
// token. Nothing below may run unless the scratch item is what actually
// resolves, so this asserts it and refuses to continue otherwise.
const resolution = await readClaudeCredential({ keychainService: SCRATCH, keychainAccount: 'user' }, configDir);
if (resolution.service !== SCRATCH || resolution.oauth?.refreshToken !== SYNTHETIC_REFRESH) {
	throw new Error(
		`refusing to run the plugin pass: the scratch credential did not resolve (service=${resolution.service}, refresh=${maskFor(resolution.oauth?.refreshToken)}); it fell through to a real credential, which a refresh would destroy`
	);
}

const outcome = await syncCredential(stub, options, state);
check('syncCredential publishes the scratch token', outcome === 'published' && refs.get('ANTHROPIC_API_KEY') === 'sk-ant-oat01-scratch-token', outcome);
const again = await syncCredential(stub, { ...options, refreshMarginMs: 0 }, state);
check('syncCredential is idempotent', again === 'unchanged', again);

refs.set('ANTHROPIC_API_KEY', 'stale');
const republished = await syncCredential(stub, { ...options, refreshMarginMs: 0 }, state);
check('syncCredential republishes when the store drifted', republished === 'published' && refs.get('ANTHROPIC_API_KEY') === 'sk-ant-oat01-scratch-token', republished);

// The scratch credential carries no refresh token, so a pass that wants to
// renew it fails fast at the token endpoint. That failure must not withhold the
// token already on disk: a route left without credentials is worse than a
// stale-but-valid one, and this is the ordering the forced-renewal run proved.
refs.set('ANTHROPIC_API_KEY', 'stale');
const renewedFail = await syncCredential(stub, { ...options, refreshMarginMs: 9_999_999_999 }, { inFlight: undefined, lastAttempt: 0 });
check('a failed renewal still publishes the usable token', renewedFail === 'published' && refs.get('ANTHROPIC_API_KEY') === 'sk-ant-oat01-scratch-token', renewedFail);
check('a failed renewal is reported', logs.some(([, m]) => m.includes('renewing the subscription token failed')));

// 7. settings write path with a descriptor present.
const settingsWrites2 = [];
const stubWithSettings = {
	...stub,
	get: (name) =>
		name === 'settings'
			? {
					describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: { providers: { cm: { apiKeyEnv: 'CM_API_KEY' } } } }],
					update: async (...args) => settingsWrites2.push(args)
				}
			: undefined
};
const declared = await ensureProvider(stubWithSettings, options);
const declaredRoute = settingsWrites2[0]?.[1]?.providers?.anthropic;
check('ensureProvider merges the route and keeps other providers', declared === true && settingsWrites2[0]?.[0] === 'llm-pi-ai' && declaredRoute?.apiKeyEnv === 'ANTHROPIC_API_KEY' && settingsWrites2[0]?.[1].providers.cm === undefined && settingsWrites2[0]?.[2] === 7, JSON.stringify(declaredRoute));
// The catalog lacks claude-opus-5-5, which this account does offer: a route the
// plugin did not create must keep the operator's model list, never empty it.
const settingsWrites3 = [];
const stubWithModels = {
	...stub,
	get: (name) =>
		name === 'settings'
			? {
					describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: { anthropic: { apiKeyEnv: 'STALE', models: [{ id: 'claude-opus-5-5', input: ['text', 'image'] }] } } } }],
					update: async (...args) => settingsWrites3.push(args)
				}
			: undefined
};
await ensureProvider(stubWithModels, options);
check('ensureProvider never rewrites an existing model list', settingsWrites3.length === 1 && settingsWrites3[0][1].providers.anthropic.models === undefined, JSON.stringify(settingsWrites3[0]?.[1]?.providers?.anthropic));
const settingsWrites4 = [];
const stubAlreadyRight = {
	...stub,
	get: (name) =>
		name === 'settings'
			? {
					describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'anthropic', models: [{ id: 'claude-opus-5-5' }] } } } }],
					update: async (...args) => settingsWrites4.push(args)
				}
			: undefined
};
const untouched = await ensureProvider(stubAlreadyRight, options);
check('ensureProvider leaves a correct route untouched', untouched === true && settingsWrites4.length === 0);

// 8. conflicting revision retries once, then gives up loudly.
let conflicts = 0;
const stubConflicting = {
	...stub,
	get: (name) =>
		name === 'settings'
			? {
					describe: () => [{ ns: 'llm-pi-ai', revision: conflicts, value: {} }],
					update: async () => {
						conflicts++;
						throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' });
					}
				}
			: undefined
};
const conflicted = await ensureProvider(stubConflicting, options);
check('ensureProvider retries a conflict once then warns', conflicted === false && conflicts === 2 && logs.some(([, m]) => m.includes('could not declare')), `attempts=${conflicts}`);

await run('/usr/bin/security', ['delete-generic-password', '-s', SCRATCH]).catch(() => {});

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
