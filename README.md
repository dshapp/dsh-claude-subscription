# dsh-claude-subscription

A DeepSeek Harness (DSH) bundle that runs the built-in Anthropic provider on a
**Claude Code subscription** (Pro / Max / Team) instead of a separately billed
API key.

DSH normally expects `ANTHROPIC_API_KEY` to hold a pay-as-you-go key. This bundle
takes the OAuth credential the `claude` CLI already stored — on macOS, the
keychain item `Claude Code-credentials` — and publishes its access token into the
credentials seam under `ANTHROPIC_API_KEY`. pi-ai recognises the `sk-ant-oat`
prefix, so requests then go out the same way the CLI sends them (Bearer auth, the
`claude-cli` user agent, the Claude Code identity system prompt), which is what a
subscription requires.

Nothing is hardcoded: no token is copied into a config file, and no secret is
written to disk by this bundle.

## What it does per pass

On startup, and then every `checkIntervalMs`, the plugin:

1. Reads the `claude` CLI credential (keychain, or `<configDir>/.credentials.json`).
2. Publishes the token it already holds, so the route works immediately.
3. If the token is inside `refreshMarginMs` of expiry, renews it against
   `https://platform.claude.com/v1/oauth/token`.
4. Writes a rotation back to the CLI credential when `writeBack` is enabled,
   after a re-read that drops the rotation if the CLI logged in concurrently —
   a lost rotation would otherwise desynchronise the two clients.
5. Declares the provider route, merging only that one route so every other
   configured provider survives.

Step 2 runs before step 3 deliberately. Renewal needs the network, and a pass
that refused to publish until it succeeded would leave the route unusable
whenever the token endpoint was slow or unreachable.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-claude-subscription
```

`dsh plugin` is a pnpm forwarder and does not boot the profile, so restart the
harness afterwards (for the web profile, restart `dsh web`).

## Configuration

Every field is volatile and editable from the settings page.

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | `anthropic` | Route key provisioned in `llm-pi-ai`. |
| `displayName` | `Claude (subscription)` | Label shown for that route. |
| `apiKeyRef` | `ANTHROPIC_API_KEY` | Credential reference the route resolves. |
| `manageProvider` | `true` | Declare the route at all. |
| `refreshMarginMs` | `300000` | How long before expiry to renew. |
| `checkIntervalMs` | `300000` | Interval between passes. |
| `writeBack` | `true` | Write a rotation back to the CLI credential. |
| `keychainService` | *(derived)* | Explicit keychain service to read. |
| `keychainAccount` | `$USER` | Keychain account to read. |
| `credentialsFile` | *(derived)* | Read a JSON credential file instead. |
| `backupDir` | `$DSH_HOME/claude-subscription` | Where pre-rotation copies go. |

### `models` is never written

The plugin sets only `apiKeyEnv` and `displayName` on its route. It does not
touch `models`, so a route that lists models keeps that exact list and a route it
creates leaves the field absent, letting the installed pi-ai catalog serve it.

That restraint is deliberate: the catalog and a subscription do not always
agree. This account offers `claude-opus-5-5`, which the catalog does not list, so
"follow the catalog" would silently delete an operator's chosen model id.

## Requirements

- macOS (keychain reads shell out to `/usr/bin/security`); a Linux/Windows port
  would read `~/.claude/.credentials.json` instead.
- A signed-in `claude` CLI. If the credential is missing the plugin logs a
  warning and leaves the route unauthenticated rather than failing the harness.

## Refresh tokens are single-use

Anthropic rotates the refresh token on every renewal, so **exactly one client may
spend a given refresh token**. This is why the plugin owns the renewal and writes
the result back: letting pi-ai refresh into DSH's own store would leave the CLI
holding a dead token.

The same fact makes tests dangerous. `test/credential.test.mjs` rewrites both
secret fields to synthetic values before writing anything, and refuses to run its
plugin pass unless the scratch keychain item — not the operator's live
credential — is what actually resolved.

## Verification

```sh
node test/credential.test.mjs
```

The suite reads the real credential but only ever writes to a throwaway keychain
item (`dsh-claude-subscription-scratch`), which it deletes afterwards. Before
running its plugin pass it rewrites **both** secret fields to synthetic values
and asserts that the scratch item — not the operator's live credential — is what
actually resolved, because `readClaudeCredential` walks a fallback chain and a
missing scratch item would otherwise silently resolve the real one. It exits
without writing anything when there is no credential to describe.

It covers service-name derivation, read/write/backup round trips, refresh maths,
refusal handling, route merging that preserves sibling providers, conflict retry,
and the publish-before-renew ordering.

### The live renewal test is opt-in

```sh
CLAUDE_LIVE_REFRESH_TEST=1 node test/refresh.live.mjs
```

This is the only code that spends a real, single-use refresh token, so it is not
part of the default run and will not start without that variable. It persists the
rotation **before** verifying anything else: Anthropic invalidates the old
refresh token as it mints the new one, so a rotated-but-unwritten token is a
destroyed credential. If persistence itself fails it says so loudly instead of
pretending a restore is possible.

### A note on the risk this code carries

Anthropic rotates refresh tokens on every renewal, which makes a careless pass
genuinely destructive: spend the token, fail to store the replacement, and the
`claude` CLI is signed out. That is a real failure mode, not a theoretical one —
it happened while this bundle was being built, to its own author's credential.
Both test files and the plugin's write-back ordering exist in the shape they do
because of it.