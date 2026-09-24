/**
 * Credential-free checks, runnable anywhere including CI.
 *
 * `credential.test.mjs` needs a real Claude Code credential and edits the
 * macOS keychain, so it cannot gate a release. This file covers the pure
 * decisions that a release could plausibly break — service derivation, expiry
 * maths, document round-tripping, route merging, publish-before-renew
 * ordering — against stubs only. It touches no keychain and no network.
 */
import { credentialsFileFor, expandHome, keychainServiceFor, needsRefresh, readOAuthFields, withOAuthFields } from '../lib/claude-code.js';
import { ensureProvider, mask, resolveOptions, syncCredential } from '../lib/index.js';

const results = [];
const check = (label, ok, detail = '') => {
	results.push({ label, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const SCRATCH = 'dsh-claude-subscription-scratch';

/** A context whose credential read always resolves the fixture below. */
function stubContext({ document, refs = new Map(), providers = {}, revision = 1 } = {}) {
	const logs = [];
	const writes = [];
	return {
		logs,
		writes,
		refs,
		ctx: {
			credentials: {
				resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined),
				set: async (ref, value) => {
					refs.set(ref, value);
				}
			},
			logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
			get: (name) =>
				name === 'settings'
					? {
							describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers } }],
							update: async (...args) => writes.push(args)
						}
					: undefined,
			effect() {},
			inject() {}
		}
	};
}

// --- pure helpers -----------------------------------------------------------

check(
	'keychainServiceFor is a stable 8-char derivation',
	keychainServiceFor('/tmp/x') === keychainServiceFor('/tmp/x') && keychainServiceFor('/tmp/x') !== keychainServiceFor('/tmp/y') && /-([0-9a-f]{8})$/.test(keychainServiceFor('/tmp/x')),
	keychainServiceFor('/tmp/x')
);
check('credentialsFileFor names the JSON fallback', credentialsFileFor('/tmp/c') === '/tmp/c/.credentials.json', credentialsFileFor('/tmp/c'));
check('expandHome expands only a leading ~', expandHome('~/a') === `${expandHome('~')}/a` && expandHome('/abs') === '/abs' && expandHome('') === '', expandHome('~/a'));

check(
	'readOAuthFields rejects a document without an access token',
	readOAuthFields(undefined) === undefined && readOAuthFields({}) === undefined && readOAuthFields({ claudeAiOauth: { accessToken: '' } }) === undefined
);
const parsed = readOAuthFields({ claudeAiOauth: { accessToken: 'a', refreshToken: '', expiresAt: 5, subscriptionType: 'team', extra: 'dropped' } });
check('readOAuthFields normalizes and drops unknown fields', parsed?.accessToken === 'a' && parsed?.refreshToken === undefined && parsed?.expiresAt === 5 && parsed?.subscriptionType === 'team' && !('extra' in parsed));

const roundTripped = withOAuthFields({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: 1, subscriptionType: 'team' } }, { accessToken: 'new', refreshToken: 'r2', expiresAt: 2 });
check(
	'withOAuthFields replaces tokens and keeps the rest',
	roundTripped.claudeAiOauth.accessToken === 'new' && roundTripped.claudeAiOauth.refreshToken === 'r2' && roundTripped.claudeAiOauth.expiresAt === 2 && roundTripped.claudeAiOauth.subscriptionType === 'team'
);
check('withOAuthFields does not mutate its input', (() => { const doc = { claudeAiOauth: { accessToken: 'old' } }; withOAuthFields(doc, { accessToken: 'new' }); return doc.claudeAiOauth.accessToken === 'old'; })());

const now = Date.now();
check('needsRefresh respects the margin', needsRefresh({ expiresAt: now + 60_000 }, 300_000) === true && needsRefresh({ expiresAt: now + 900_000 }, 300_000) === false);
check('needsRefresh is false when expiry is unknown', needsRefresh({}, 300_000) === false);
check('mask never reveals a whole secret', mask('sk-ant-oat01-abcdefghijklmnop').length < 'sk-ant-oat01-abcdefghijklmnop'.length && mask('short').includes('5'));

const options = { ...resolveOptions(), keychainService: SCRATCH, keychainAccount: 'user' };
check('resolveOptions fixes the route, label and reference', options.provider === 'anthropic' && options.displayName === 'anthropic' && options.apiKeyRef === 'ANTHROPIC_API_KEY', JSON.stringify({ provider: options.provider, displayName: options.displayName, apiKeyRef: options.apiKeyRef }));

// --- route declaration ------------------------------------------------------

{
	const { ctx, writes } = stubContext({ providers: {} });
	const ok = await ensureProvider(ctx, options);
	check(
		'ensureProvider declares the route with both fields',
		ok === true && writes[0]?.[0] === 'llm-pi-ai' && writes[0]?.[1].providers.anthropic.apiKeyEnv === 'ANTHROPIC_API_KEY' && writes[0]?.[1].providers.anthropic.displayName === 'anthropic'
	);
}
{
	// The catalog lacks claude-opus-5-5 but an account can offer it: the plugin
	// must settle its own two fields and never touch the operator's model list.
	const { ctx, writes } = stubContext({ providers: { anthropic: { apiKeyEnv: 'STALE', models: [{ id: 'claude-opus-5-5' }] } } });
	await ensureProvider(ctx, options);
	check('ensureProvider never rewrites a model list', writes[0]?.[1].providers.anthropic.models === undefined && writes[0]?.[1].providers.anthropic.apiKeyEnv === 'ANTHROPIC_API_KEY');
}
{
	const { ctx, writes } = stubContext({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'anthropic' } } });
	const untouched = await ensureProvider(ctx, options);
	check('ensureProvider leaves a correct route alone', untouched === true && writes.length === 0);
}
{
	const { ctx } = stubContext({ providers: {} });
	ctx.get = () => undefined;
	const declined = await ensureProvider(ctx, options);
	check('ensureProvider declines when there is no settings service', declined === false);
}

// --- publish behaviour ------------------------------------------------------

const SYNTHETIC_ACCESS = 'sk-ant-oat01-scratch-token';
const SYNTHETIC_REFRESH = 'sk-ant-ort01-scratch-token';
/** A credential record shaped like the one the reader returns. */
const credentialOf = (oauth) => ({ source: 'keychain', service: SCRATCH, account: 'user', document: { claudeAiOauth: { ...oauth } }, oauth });
const LIVE = credentialOf({ accessToken: SYNTHETIC_ACCESS, refreshToken: SYNTHETIC_REFRESH, expiresAt: Date.now() + 3_600_000, subscriptionType: 'team' });
/** Never let a check reach the network: a renewal here is a failure, not a pass. */
const forbiddenRenew = async () => { throw new Error('the token endpoint must not be contacted by this suite'); };

{
	// A pass with nothing to renew only publishes: no network call is reachable
	// from here, so reaching one would hang or throw rather than pass.
	const { ctx, refs, logs } = stubContext({ refs: new Map() });
	const outcome = await syncCredential(ctx, options, { lastAttempt: 0 }, { read: async () => LIVE, renew: forbiddenRenew });
	check('syncCredential publishes the current token', outcome === 'published' && refs.get('ANTHROPIC_API_KEY') === SYNTHETIC_ACCESS, outcome);
	check('syncCredential logs a masked token only', logs.every(([, m]) => !m.includes(SYNTHETIC_ACCESS)), 'no raw token in logs');
}
{
	const { ctx, refs } = stubContext({ refs: new Map([['ANTHROPIC_API_KEY', SYNTHETIC_ACCESS]]) });
	const again = await syncCredential(ctx, options, { lastAttempt: 0 }, { read: async () => LIVE, renew: forbiddenRenew });
	check('syncCredential is idempotent', again === 'unchanged', again);
}
{
	const { ctx, refs } = stubContext({ refs: new Map([['ANTHROPIC_API_KEY', 'stale']]) });
	const republished = await syncCredential(ctx, options, { lastAttempt: 0 }, { read: async () => LIVE, renew: forbiddenRenew });
	check('syncCredential republishes when the store drifted', republished === 'published' && refs.get('ANTHROPIC_API_KEY') === SYNTHETIC_ACCESS);
}
{
	// No credential at all: warn, change nothing, and never throw — an
	// unreachable credential source must not take the harness down.
	const { ctx, refs, logs } = stubContext({ refs: new Map([['ANTHROPIC_API_KEY', 'stale-must-not-change']]) });
	const outcome = await syncCredential(ctx, options, { lastAttempt: 0 }, { read: async () => ({ source: 'keychain', service: SCRATCH, oauth: undefined, failures: ['not found'] }), renew: forbiddenRenew });
	check('syncCredential reports a missing credential', outcome === 'missing', outcome);
	check('syncCredential leaves the store alone when signed out', refs.get('ANTHROPIC_API_KEY') === 'stale-must-not-change');
	check('syncCredential warns about the missing credential', logs.some(([, m]) => m.includes('no Claude Code credential')));
}
{
	// Publish ordering: with an already-expired token the pass still publishes
	// before it attempts the (here unreachable) renewal, so the route keeps
	// whatever credential exists instead of going bare.
	const { ctx, refs } = stubContext({ refs: new Map() });
	const expired = credentialOf({ accessToken: SYNTHETIC_ACCESS, refreshToken: SYNTHETIC_REFRESH, expiresAt: Date.now() - 1 });
	const outcome = await syncCredential(ctx, options, { lastAttempt: 0 }, { read: async () => expired, renew: forbiddenRenew });
	check('syncCredential publishes before renewing an expired token', refs.get('ANTHROPIC_API_KEY') === SYNTHETIC_ACCESS, `${outcome}, store=${refs.get('ANTHROPIC_API_KEY') === SYNTHETIC_ACCESS ? 'published' : 'empty'}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
	console.error(`\n${failed.length} FAILED:\n${failed.map((r) => `  - ${r.label}`).join('\n')}`);
	process.exit(1);
}
console.log('All credential-free checks passed.');