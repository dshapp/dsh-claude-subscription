# dsh-claude-subscription

[中文](README.zh.md)

Run **Claude models inside DeepSeek Harness on your Claude Code subscription** —
no separate Anthropic API key, no per-token billing.

You sign in to the `claude` CLI once. This bundle picks that credential up and
hands it to the harness's built-in Anthropic provider, so DSH and the CLI draw on
the same subscription.

## What you get

- **Claude models in DSH** — Opus, Sonnet, Haiku, whichever your plan covers.
- **No API key to buy or paste.** If `claude` works on this machine, DSH works.
- **Stays signed in.** The token is renewed automatically, in the background.
- **One credential, not two.** Renewal is written back, so the CLI keeps working
  and you never sign in twice.
- **Nothing else disturbed.** Your other providers, your default model, and your
  model list are all left alone.
- **Works in any profile.**

## Requirements

- **macOS.** The credential is read from the login keychain.
- **A Claude Code subscription** (Pro / Max / Team), signed in at least once.
- DSH installed, and the `claude` CLI on your `PATH`.

## Install

```sh
dsh plugin --profile web add github:dshapp/dsh-claude-subscription
```

Or from a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-claude-subscription
```

Then **restart the harness** — `dsh plugin` installs but does not boot the
profile, so a running `dsh web` will not have loaded it yet.

## Sign in once

If you have never used the CLI on this machine:

```sh
claude
```

Complete the browser sign-in. The plugin has nothing else to configure — on the
next harness start it finds the credential and the Anthropic route becomes
usable.

## Pick your model

The `anthropic` route serves every Claude model in the built-in catalog, so for
most people there is nothing to do: open the **Models** page and choose one.

To use a model the catalog does not know about — a newer release, say — declare
it in the profile's `cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        models:
          - id: claude-opus-5-5
            input:
              - text
              - image
```

> **Careful:** declaring `models` **replaces the whole catalog** for that route,
> it does not extend it. Listing one model means that route serves *only* that
> one. To keep the catalog models around, list them all, or leave the field out
> entirely and pick from the catalog instead.

This bundle never writes `models` itself, so whatever you declare here survives.

## Configuration

**There is none.** A subscription credential has one sensible location, one
reference, and one renewal schedule, so the bundle hardcodes them instead of
offering knobs whose only correct setting is the default:

- route `anthropic`, shown as **anthropic**, resolving `ANTHROPIC_API_KEY`
- the credential is found automatically, and renewals are written back
- the token is renewed shortly before it expires, and re-checked every 5 minutes
- pre-renewal copies go to `$DSH_HOME/claude-subscription`

To change any of it, edit `lib/index.js` — the constants sit at the top.

## Everyday behaviour

- The route is usable a moment after the harness starts.
- The token renews itself roughly every 8 hours; the plugin checks every 5
  minutes and only acts when renewal is actually due.
- Left the harness off for a long stretch? The next start renews the token, so
  there is nothing to do on your side.
- Ran `claude` and signed in as someone else? The next check picks up the new
  credential.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no Claude Code credential …` in the log, Anthropic route errors | Not signed in on this machine. Run `claude` and complete the sign-in. |
| The route is missing from the Models page | The harness has not loaded the bundle since install. Restart it. |
| `401` / "OAuth access token has been revoked" | The stored token went stale. Run `claude` to sign in again; the next check republishes it. |
| `429 rate_limit_error` | Your plan's rate limit, not a bug. Wait, or use a smaller model. |
| Only one Claude model is selectable | That route declares a `models` list, which replaces the catalog. See [Pick your model](#pick-your-model). |
| The `claude` CLI stopped working after DSH used it | Both share one credential. Sign in with `claude` again — DSH will follow. |

## Uninstall

```sh
dsh plugin --profile web remove dsh-claude-subscription
```

Restart afterwards. Your `claude` CLI credential is untouched — remove it with
`claude logout` if you want it gone too.

## Notes

- **Not affiliated with Anthropic.** This is an interoperability plugin. It
  reuses a credential you already have; it does not grant access to anything.
- **Your subscription, your terms.** Sharing a subscription credential with
  another client is your call, and may not match Anthropic's terms of service.
  Use it for your own machine the way you would use the CLI.
- **One credential, two clients.** DSH and `claude` share a single signed-in
  session, so a sign-out on either side affects both.

## Development

```sh
pnpm install
node test/credential.test.mjs
```

The suite needs a live `claude` credential to describe. It only ever writes to a
throwaway keychain item, which it deletes afterwards, and it refuses to run when
that item is not what resolved.

A separate opt-in check exercises the live renewal path. It spends a real
single-use refresh token, so it never runs by default:

```sh
CLAUDE_LIVE_REFRESH_TEST=1 node test/refresh.live.mjs
```

## License

[MIT](LICENSE)