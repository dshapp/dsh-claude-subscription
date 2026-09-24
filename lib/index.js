/**
 * dsh-claude-subscription: run the harness's built-in Anthropic route on an
 * existing Claude Code (Pro/Max/Team) subscription credential.
 *
 * The plugin reads the OAuth credential the `claude` CLI already stores,
 * renews it before it expires, writes the rotation back where it came from so
 * the CLI and this harness keep sharing one refresh token instead of
 * invalidating each other, and publishes the access token into the
 * credentials seam under the reference the Anthropic route resolves. The
 * harness's `llm-pi-ai` adapter already speaks pi-ai's Claude-subscription
 * dialect — Bearer `authToken` plus the Claude Code identity headers and
 * system prompt — so no wire code lives here.
 *
 * @module dsh-claude-subscription
 */
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { backupClaudeCredential, needsRefresh, readClaudeCredential, refreshClaudeCredential, resolveClaudeConfigDir, withOAuthFields, writeClaudeCredential } from './claude-code.js';

/** Settings namespace owning the harness's provider profiles. */
const LLM_SETTINGS_NAMESPACE = 'llm-pi-ai';
/** Provider route key this plugin provisions inside that namespace. */
const DEFAULT_PROVIDER = 'anthropic';
/** Reference the harness resolves the subscription token through. */
const DEFAULT_API_KEY_REF = 'ANTHROPIC_API_KEY';
/** How long before expiry the token is renewed, matching pi-ai's own margin. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How often the credential is re-read, so a CLI-side login reaches the harness. */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Shortest spacing between two token-endpoint attempts, so a failing refresh cannot spin. */
const MIN_REFRESH_ATTEMPT_INTERVAL_MS = 60 * 1000;
/** Route keys a settings document can address. */
const ROUTE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Environment-variable spelling a credential reference must take. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Directory name of the default harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh';
/** Environment variable overriding the default harness home. */
const DSH_HOME_ENV = 'DSH_HOME';

/**
* Resolve a path under the harness home, matching the harness's own precedence:
* `$DSH_HOME` when it is set and not blank, else `~/.dsh`. Inlined rather than
* imported so this bundle carries no cordis-coupled runtime dependency.
* @param segments - path segments appended to the resolved harness home.
* @returns the absolute joined path.
*/
function dshHomePath(...segments) {
	const configured = process.env[DSH_HOME_ENV];
	const home = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), DSH_HOME_DIR_NAME);
	return join(resolve(home), ...segments);
}

/** Plugin configuration; every field is volatile and editable from the settings page. */
const Config = z.object({
	provider: z.string().default(DEFAULT_PROVIDER).volatile(),
	displayName: z.string().default('Claude (subscription)').volatile(),
	apiKeyRef: z.string().role('credential-ref').default(DEFAULT_API_KEY_REF).volatile(),
	manageProvider: z.boolean().default(true).volatile(),
	refreshMarginMs: z.number().step(1).min(0).default(DEFAULT_REFRESH_MARGIN_MS).volatile(),
	checkIntervalMs: z.number().step(1).min(1000).default(DEFAULT_CHECK_INTERVAL_MS).volatile(),
	writeBack: z.boolean().default(true).volatile(),
	configureProvider: z.boolean().default(true).volatile(),
	keychainService: z.string().default('').volatile(),
	keychainAccount: z.string().default('').volatile(),
	credentialsFile: z.string().default('').volatile(),
	backupDir: z.string().default('').volatile()
});

/** The plugin's registered name, which is also its configuration namespace. */
export const name = 'claude-subscription';

/** Services this plugin requires before it activates. */
export const inject = ['credentials'];

/**
* Mask a secret for a log line, keeping only enough of it to tell two
* credentials apart.
* @param value - the secret.
* @returns a short, non-reversible label.
*/
function mask(value) {
	return value.length <= 18 ? `${value.slice(0, 8)}…(${value.length})` : `${value.slice(0, 18)}…(${value.length})`;
}

/**
* Read the live configuration once, so a settings edit reaches the next pass
* without a plugin restart.
* @param ctx - plugin context.
* @param config - validated plugin configuration.
* @returns a detached snapshot.
*/
export function snapshot(ctx, config) {
	return {
		provider: config.provider.get(),
		displayName: config.displayName.get(),
		apiKeyRef: config.apiKeyRef.get(),
		manageProvider: config.manageProvider.get(),
		refreshMarginMs: config.refreshMarginMs.get(),
		checkIntervalMs: config.checkIntervalMs.get(),
		writeBack: config.writeBack.get(),
		configureProvider: config.configureProvider.get(),
		keychainService: config.keychainService.get(),
		keychainAccount: config.keychainAccount.get() || process.env.USER || process.env.LOGNAME || '',
		credentialsFile: config.credentialsFile.get(),
		backupDir: config.backupDir.get() || dshHomePath('claude-subscription')
	};
}

/**
* Declare this plugin's provider route in the settings document when it is
* missing or still points elsewhere, merging only that one route so every
* other configured provider survives. `models` is never written: a route that
* already lists models keeps that exact list, and a route this plugin creates
* leaves the field absent so the installed pi-ai catalog serves the route.
* That restraint matters because the catalog and a subscription do not always
* agree — the account can offer a model the catalog has not heard of — and a
* plugin that owns credentials has no business deleting a model id the operator
* chose.
* @param ctx - plugin context.
* @param options - configuration snapshot.
* @returns true when the document already described the wanted route.
*/
export async function ensureProvider(ctx, options) {
	const settings = ctx.get('settings');
	if (settings === undefined) {
		ctx.logger.warn('claude-subscription: no settings service here, so the Anthropic route was not declared; configure it by hand or run the web profile');
		return false;
	}
	if (!ROUTE_KEY_PATTERN.test(options.provider)) {
		ctx.logger.warn(`claude-subscription: provider "${options.provider}" is not a storable route key; leaving the provider document alone`);
		return false;
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const descriptor = settings.describe().find((row) => row.ns === LLM_SETTINGS_NAMESPACE);
		if (descriptor === undefined) {
			ctx.logger.warn(`claude-subscription: this profile has no "${LLM_SETTINGS_NAMESPACE}" settings entry, so the Anthropic route was not declared`);
			return false;
		}
		const existing = descriptor.value?.providers?.[options.provider];
		const wanted = {
			displayName: existing?.displayName ?? options.displayName,
			apiKeyEnv: options.apiKeyRef
		};
		if (existing !== undefined && existing.apiKeyEnv === wanted.apiKeyEnv && existing.displayName !== undefined) return true;
		try {
			await settings.update(LLM_SETTINGS_NAMESPACE, { providers: { [options.provider]: wanted } }, descriptor.revision);
			const served = existing?.models === undefined ? 'the installed Claude catalog' : `its ${existing.models.length} configured model(s)`;
			ctx.logger.info(`claude-subscription: declared provider route "${options.provider}" resolving ${options.apiKeyRef}, served by ${served}`);
			return true;
		} catch (error) {
			if (error?.code !== 'SETTINGS_CONFLICT' || attempt > 0) {
				ctx.logger.warn(`claude-subscription: could not declare the "${options.provider}" route: ${error.message}`);
				return false;
			}
		}
	}
	return false;
}

/**
* Publish one token into the credentials seam, so the Anthropic route resolves
* it. This is the fast, local half of a pass and deliberately runs before any
* network work: the token already on disk is usable right now, and the harness
* must not be left unable to reach a route while a renewal is still in flight.
* @param ctx - plugin context.
* @param options - configuration snapshot.
* @param credential - the credential document the token came from.
* @param oauth - the OAuth fields to publish.
* @returns a machine-readable outcome.
*/
export async function publishToken(ctx, options, credential, oauth) {
	// The seam brands references for typing only; a plain string is what the
	// provider reads, so validating the spelling here is the whole contract.
	if (!CREDENTIAL_REF_PATTERN.test(options.apiKeyRef)) {
		ctx.logger.warn(`claude-subscription: "${options.apiKeyRef}" is not a usable credential reference name; skipping the publish step`);
		return 'invalid-ref';
	}
	const ref = options.apiKeyRef;
	const held = await ctx.credentials.resolve(ref);
	if (held?.value === oauth.accessToken) return 'unchanged';
	try {
		await ctx.credentials.set(ref, oauth.accessToken);
		const where = credential.source === 'keychain' ? credential.service : credential.path;
		const expiry = oauth.expiresAt === undefined ? 'unknown' : new Date(oauth.expiresAt).toISOString();
		ctx.logger.info(`claude-subscription: published ${ref} from ${where} (${mask(oauth.accessToken)}, expires ${expiry}, ${oauth.subscriptionType ?? 'unknown'} plan)`);
		return 'published';
	} catch (error) {
		ctx.logger.warn(`claude-subscription: could not store ${ref} (${error.message}); export it in the launching environment instead`);
		return 'unwritable';
	}
}

/**
* Read the CLI credential, then publish the token it already holds before doing
* anything slow. A renewal needs the network, and the route must stay usable
* throughout: the token on disk is valid until it expires, so the harness gets
* it immediately and a rotation — if one is due — is published as a
* correction afterwards.
*
* Every failure is logged and swallowed: an unreachable token endpoint must
* never take the harness down.
* @param ctx - plugin context.
* @param options - configuration snapshot.
* @param state - per-plugin pass state (refresh throttling).
* @returns a machine-readable outcome for the pass.
*/
export async function syncCredential(ctx, options, state) {
	const configDir = resolveClaudeConfigDir(undefined);
	const credential = await readClaudeCredential(options, configDir);
	if (credential.oauth === undefined) {
		const detail = credential.failures?.length ? credential.failures.join('; ') : 'no credential found';
		ctx.logger.warn(`claude-subscription: no Claude Code credential under ${configDir} (${detail}); sign in with \`claude\` and this route starts working`);
		return 'missing';
	}
	const current = credential.oauth;
	const first = await publishToken(ctx, options, credential, current);
	// An expired token cannot serve a request, so only a still-usable one lets a
	// throttled pass stop here; otherwise the renewal below is the whole point.
	const usable = current.expiresAt === undefined || current.expiresAt > Date.now();
	if (!needsRefresh(current, options.refreshMarginMs)) return first;
	if (usable && Date.now() - state.lastAttempt < MIN_REFRESH_ATTEMPT_INTERVAL_MS) return first;
	state.lastAttempt = Date.now();
	let oauth;
	try {
		oauth = await refreshClaudeCredential(current, undefined);
	} catch (error) {
		ctx.logger.warn(`claude-subscription: renewing the subscription token failed (${error.message}); keeping the current one`);
		return first;
	}
	if (options.writeBack) {
		const recheck = await readClaudeCredential(options, configDir);
		if (recheck.oauth === undefined || recheck.oauth.accessToken !== current.accessToken) {
			ctx.logger.warn('claude-subscription: the Claude Code credential changed while it was being renewed, so the rotation was dropped rather than overwrite a newer login');
			if (recheck.oauth !== undefined) return publishToken(ctx, options, recheck, recheck.oauth);
			return first;
		}
		try {
			const backups = await backupClaudeCredential(credential, options.backupDir);
			const written = await writeClaudeCredential(credential, withOAuthFields(credential.document, oauth), options);
			ctx.logger.info(`claude-subscription: rotated the Claude Code credential in ${written} (backups: ${backups.join(', ')})`);
		} catch (error) {
			ctx.logger.warn(`claude-subscription: the Claude Code credential could not be updated (${error.message}); this harness now holds a token the \`claude\` CLI does not`);
		}
	}
	return publishToken(ctx, options, credential, oauth);
}

/**
* Mount the subscription credential bridge: declare the route once, publish
* the token immediately, then re-check on an interval so a CLI-side renewal or
* a mid-session expiry is picked up without restarting the harness.
* @param ctx - plugin context.
* @param config - validated plugin configuration.
*/
export function apply(ctx, config) {
	const state = { inFlight: undefined, lastAttempt: 0 };
	const run = (reason) => {
		if (state.inFlight !== undefined) return state.inFlight;
		const options = snapshot(ctx, config);
		state.inFlight = (async () => {
			try {
				if (options.configureProvider) await ensureProvider(ctx, options);
				await syncCredential(ctx, options, state);
			} catch (error) {
				ctx.logger.warn(`claude-subscription: ${reason} pass failed: ${error.message}`);
			} finally {
				state.inFlight = undefined;
			}
		})();
		return state.inFlight;
	};
	ctx.effect(() => {
		void run('startup');
	});
	ctx.inject(['timer'], (timer) => {
		timer.interval(() => {
			void run('scheduled');
		}, Math.max(1000, snapshot(ctx, config).checkIntervalMs));
	});
}

export { Config, DEFAULT_API_KEY_REF, DEFAULT_CHECK_INTERVAL_MS, DEFAULT_PROVIDER, DEFAULT_REFRESH_MARGIN_MS, LLM_SETTINGS_NAMESPACE, mask };