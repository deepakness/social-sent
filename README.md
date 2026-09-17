# SocialSent

[![CI](https://github.com/deepakness/social-sent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepakness/social-sent/actions/workflows/ci.yml)

Minimal social scheduler for Mastodon, Bluesky, LinkedIn, Threads, and X. SvelteKit on the Cloudflare stack (Workers, D1, R2).

Write a draft, optionally customize per platform, then publish now or schedule. Bring your own credentials: single-tenant by design, with one admin account on your own Cloudflare account.

Ready to run your own? [Deploy](#deploy) takes one command — or the Deploy to Cloudflare button, if you would rather not open a terminal.

## Stack

- SvelteKit 2 + Svelte 5
- Cloudflare Workers + Static Assets
- D1 (SQLite) via Drizzle
- R2 for images
- GitHub Actions (or any cron) calling `/api/internal/tick` for scheduled posts

## Requirements

- Node 22.12+
- A Cloudflare account with Workers, D1, and R2 available. Cloudflare asks for a payment method on file to enable R2, even for free-tier usage.
- Nothing else for scheduled posts: `wrangler.jsonc` ships a per-minute cron trigger, and the Worker publishes due posts on its own. See [Scheduling](#scheduling) if you would rather ping `/api/internal/tick` from your own cron instead.

## Local

```sh
cp .dev.vars.example .dev.vars
# generate APP_ENCRYPTION_KEY (`openssl rand -hex 32`); it is the only one needed
# optional: API_TOKEN for script access (min 16 chars)

npm install
npm run db:migrate:local
npm run dev
```

Open http://localhost:5173 and create the account on the first visit (any email and password you like) — the login lives in D1 and is changed in **Settings → Login**. Setting `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.dev.vars` keeps the login in env instead, which is useful for throwaway test databases.

First sign-in asks you to enroll an authenticator (Google Authenticator or any TOTP app). Save the backup codes. For friction-free local dev, set `SKIP_TOTP=1` in `.dev.vars` — 2FA is skipped entirely, and the flag is honored only while the instance resolves to a localhost URL, so it can never disable 2FA on a real host. Remove it (and restart) to go back to real 2FA.

```sh
npm test          # vitest
npm run check     # svelte-check
npm run build     # production worker + wrap scheduled handler
```

Local `npm run dev` ticks due posts every 30s automatically. When anything looks
wrong — locally or on a deployment — `npm run doctor` reports what it finds and
what to do about it.

`npm run test:e2e` runs the Playwright suite against a local build of the Worker. It keeps to itself: its D1/R2 state lives in `.wrangler/e2e-state`, so your `npm run dev` data is never touched. If you have no `.dev.vars`, the suite seeds one from `tests/e2e/fixtures/dev.vars` (an existing file is used as-is, so put `SKIP_TOTP=1` in yours to match the path CI takes).

## Deploy

There are two paths. The one command below is the most reliable — it needs no
GitHub integration and no Workers Builds — and the button is there if you would
rather not open a terminal. Either way, `npm run doctor` checks the result
afterwards, and [DEPLOY.md](DEPLOY.md) has the troubleshooting.

### Recommended: one command

```sh
git clone --depth 1 --branch stable https://github.com/deepakness/social-sent.git sent
cd sent && npm install && npm run setup
```

`stable` is the branch releases are cut from and what these docs are tested
against; tags mark individual releases, and `main` is where new commits land
first — see [Updating](#updating) for moving between them. `npm run setup` is
the same on any path: idempotent, safe to re-run, and it prints what it did.

It signs in through `wrangler login` (no API token to mint), creates the D1 database and R2 bucket if they are missing, generates `APP_ENCRYPTION_KEY`, writes it to `.dev.vars` and to the Worker, applies the migrations, deploys, and pins `APP_URL` to the URL it just deployed to — when the deploy prints one; otherwise it prints the command to set it yourself. (You can also skip that: an unset `APP_URL` follows the host each request arrives on.)

**It is safe to re-run, and it will not damage a running deployment.** Resources that exist are reused, a `database_id` already in your config is never replaced, and any secret already set on the Worker is left alone — rotating `APP_ENCRYPTION_KEY` orphans every stored credential, and changing `ADMIN_EMAIL` deletes the old user row and everything cascading from it, so neither happens by accident. Pass `--rotate-secrets` or `--set-admin` when that is what you want. `npm run setup -- --dry-run` prints the plan and only performs read-only calls.

### Or: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/deepakness/social-sent)

Cloudflare clones this repo into your own GitHub account, creates the Worker, **provisions the D1 database and the R2 bucket** (`wrangler.jsonc` deliberately leaves `database_id` empty for exactly that reason), asks for one secret, and wires up Workers Builds so later pushes deploy themselves.

| Form field                                   | What to do                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git account, private repo, project name      | Leave as they are. The project name becomes the Worker name.                                                                                                                    |
| D1 database, location hint, read replication | Accept **Create new** and the prefilled `socialsent`. The binding uses the database id, so the name is only a label.                                                            |
| R2 bucket                                    | `socialsent-media` is prefilled. R2 names are unique across all Cloudflare accounts, so if the form says it already exists, change it — nothing in the app depends on the name. |
| `APP_ENCRYPTION_KEY`                         | **The one secret.** Run `openssl rand -hex 32` in a terminal and paste the result. It encrypts the tokens of every account you connect; changing it later disconnects them all. |
| Build command, deploy command                | Leave as detected (`npm run build`, `npm run deploy`).                                                                                                                          |
| Builds for non-production branches           | Optional. Other branches get built, but with `preview_urls` off no public preview hostname is created.                                                                          |
| Protect with Cloudflare Access               | Leave off unless you add the exemptions in [Putting it behind Cloudflare Access](#putting-it-behind-cloudflare-access). The app has its own login.                              |

Nothing needs to be configured for the URL: a deployment cannot know it before the Worker exists, so the app uses the origin each request arrives on (and remembers it for the cron tick, which has no request of its own). Set `APP_URL` only to pin a deliberate origin.

What it cannot do — two things you finish by hand:

- **OAuth apps** for LinkedIn, Threads and X have to be registered at each provider (see [OAuth app setup](#oauth-app-setup)), and their redirect URIs need the final URL.
- **Updates are yours.** The button makes a copy, not a fork: `git remote add upstream https://github.com/deepakness/social-sent && git pull upstream main`.

If the form reports that your GitHub authorization has expired, or a build fails
while cloning the source repository, the fix is in
[DEPLOY.md](DEPLOY.md#troubleshooting) — both have a documented way out, and the
one-command path above needs neither Workers Builds nor the GitHub App.

### Or: step by step

Every command below goes through `scripts/wrangler.mjs`, which is what applies your `wrangler.personal.jsonc` and `WRANGLER_PROFILE` — plain `npx wrangler …` would target the generic config in the repo instead.

#### 1. Create the storage

```sh
node scripts/wrangler.mjs d1 create socialsent        # prints the database_id
node scripts/wrangler.mjs r2 bucket create socialsent-media
```

Before your first deploy, copy the committed config to `wrangler.personal.jsonc` (gitignored) and put the printed `database_id` and your bucket name there — see [Keeping your own deployment separate from upstream](#keeping-your-own-deployment-separate-from-upstream). Leaving `database_id` empty is also fine: Wrangler then creates the database itself on first deploy.

#### 2. Set the Worker secrets

These must be Worker secrets, not `[vars]`: a deploy overwrites `vars` with whatever `wrangler.jsonc` says, so anything committed there is public and gets reset on every deploy.

```sh
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY   # openssl rand -hex 32
node scripts/wrangler.mjs secret put API_TOKEN            # openssl rand -hex 32
```

That is the whole list: `AUTH_SECRET` and `SCHEDULER_SECRET` are derived from `APP_ENCRYPTION_KEY`, `APP_URL` is derived from the request, and the login is created on the first visit — see [Secrets](#secrets). Optional extras:

```sh
# Public media origin for Meta's crawler (an R2 custom domain behind Cloudflare's cache)
node scripts/wrangler.mjs secret put MEDIA_PUBLIC_BASE_URL
# Failure digest via Resend
node scripts/wrangler.mjs secret put RESEND_API_KEY
node scripts/wrangler.mjs secret put NOTIFY_EMAIL
node scripts/wrangler.mjs secret put NOTIFY_FROM
```

Instead of typing these one by one, `npm run secrets:put` uploads the keys it manages from `.dev.vars` (and `.api-token` for `API_TOKEN`). That allowlist covers the app's own secrets — the notification variables above are not in it, set them yourself. It refuses to upload a localhost `APP_URL`.

#### 3. Deploy

```sh
npm run build && npm run deploy
```

`npm run build` produces the Worker bundle and `npm run deploy` uploads it — the same split Workers Builds uses on every push. `npm run deploy:release` runs the whole path in one go: unit tests, remote D1 migrations, build, deploy.

### Scheduling

Scheduled posts save to D1 and are published by a per-minute cron trigger, which `wrangler.jsonc` ships enabled (`"triggers"`). The handler is a no-op when there is nothing to authenticate the tick with, so an instance without either secret simply does not publish on a schedule. The Workers free plan allows five cron triggers per account; each run gets the plan's CPU budget, the same one an HTTP tick gets, so a tick that runs out of budget leaves the rest due for the next minute.

To drive the tick from something else instead — cron-job.org, a Raspberry Pi, a systemd timer, the bundled GitHub Actions workflow, a different cadence on a paid plan — POST to:

```sh
curl -X POST "$APP_URL/api/internal/tick" \
  -H "Authorization: Bearer $SCHEDULER_SECRET" \
  -H "Content-Type: application/json"
```

Both headers matter: the endpoint takes `SCHEDULER_SECRET` (`API_TOKEN` still works as a fallback; `AUTH_SECRET` never does — it signs sessions and is rejected on the wire), and `Content-Type: application/json` is required because SvelteKit's built-in CSRF guard rejects form-encoded POSTs without an `Origin` header (403) before app code ever runs. Clients that default to a form content type must override it.

An external caller needs a bearer it can read, and the derived one is not readable from outside, so set `SCHEDULER_SECRET` (`openssl rand -hex 32`) when you add a pinger. It then lives in two places — the Worker secret and the pinger's config — so rotate both together. Without it (and without `API_TOKEN`) an external caller cannot authenticate at all; the built-in cron keeps working either way, because the Worker derives the same value. The bundled GitHub workflow stays off until you set repository secrets `APP_URL` and `SCHEDULER_SECRET`; with the built-in cron running, treat it as a backup rather than the primary tick. It is scheduled every five minutes (GitHub's shortest interval) but GitHub throttles it to roughly one run every two hours. Queue treats a heartbeat older than 6 hours as delayed. You can also run it manually from **Actions → Scheduler tick → Run workflow**.

A tick publishes as many due targets as it can inside D1's per-invocation statement budget (50 on the free plan, which is roughly three or four posts), then stops and leaves the rest due — the next tick picks them up. A backlog therefore drains a few posts per tick rather than all at once, and nothing is lost if a tick dies half-way.

Ticks are idempotent, so an extra caller is safe rather than harmful — but there is no reason to run a per-minute pinger alongside the cron. Keep one primary tick and, at most, the throttled GitHub backup.

To change the cadence, edit `triggers.crons` in `wrangler.jsonc` (`*/5 * * * *` and friends are fine on the free plan too). To use no trigger at all, delete the `triggers` block and point a pinger at the endpoint instead.

### Failure alerts (optional)

The dashboard shows a "failed to publish" banner linking to the Failed tab. To also get a morning-after email, set `RESEND_API_KEY` and `NOTIFY_EMAIL` as Worker secrets (the app no-ops without them), plus an optional `NOTIFY_FROM` sender on a domain verified in Resend. At most one digest is sent per 24h window, covering failures newer than the last digest. Posts that are still retrying are not emailed.

### Changing the login later

**Settings → Login** changes the email or the password (the current password is required, and changing it signs every device out). That works on the default, D1-managed login.

If you set `ADMIN_EMAIL` / `ADMIN_PASSWORD` as Worker secrets, those stay authoritative and the Settings card says so: update them with `node scripts/wrangler.mjs secret put ADMIN_PASSWORD`. Changing `ADMIN_EMAIL` is a bigger deal — the app keeps exactly one user row and sweeps any row whose email differs, so the old row (and everything cascading from it) is removed on the next request. Delete both secrets to go back to the in-app login; the existing row keeps working.

## Updating

```sh
git pull                     # or: git pull upstream main, if you deployed from the button
npm ci
npm run deploy:release       # unit tests, remote D1 migrations, build, deploy
npm run doctor               # optional: verify secrets, database, bucket and deployment
```

Installed from `stable`? Pull that branch (`git pull origin stable`) or move to a
release tag (`git tag` lists them) — those are the states the one-command install
and the docs are tested against. A button-created copy tracks `main` unless you
change it.

`APP_URL`, the instance name and the rest of your configuration live in `wrangler.personal.jsonc`, Worker secrets and D1, so a pull never overwrites them. Deploying from the button instead? Push the same changes to your own copy (or pull from upstream first) and Workers Builds takes it from there.

One exception: because a personal config replaces the committed one, a config change upstream does not reach your deployment. Updating from a checkout that predates the built-in scheduler? Add these two keys to `wrangler.personal.jsonc` or scheduled posts stay silent:

```jsonc
"triggers": { "crons": ["* * * * *"] }
```

## Keeping your own deployment separate from upstream

If you run your own instance while pulling updates from this repo, keep your instance-specific values in `wrangler.personal.jsonc` (gitignored) instead of editing `wrangler.jsonc`. Copy the committed file and change `name`, `database_id`, `database_name`, and `bucket_name`.

Every npm script goes through `scripts/wrangler.mjs`, which passes `--config wrangler.personal.jsonc` automatically when that file exists, plus `--profile <name>` when `WRANGLER_PROFILE` is set:

```sh
WRANGLER_PROFILE=my-account npm run deploy
```

Because your changes live in files upstream never touches, `git pull upstream main` stays conflict-free.

## Naming your instance

The instance name — shown in the page title, the header, and the login screen — is set in **Settings → Instance** and stored in D1, so it needs no redeploy. `APP_NAME` (a plain `[vars]` entry, default `SocialSent`) is the fallback for deployments that would rather keep it in config. The outbound `User-Agent`, the Mastodon app name, cookies, and API-key prefixes stay fixed so upgrades keep working.

`APP_URL` (a Worker secret, not a var) is the instance's public origin. It is optional: left unset, the app uses the origin each request arrives on and remembers the first authenticated one, which is how a deployment works without knowing its URL in advance. Set it to pin a deliberate origin — a custom domain, or the hostname OAuth redirect URIs and signed media URLs must use. A pinned value does not follow a hostname change, so update it if you move.

## Secrets

`APP_ENCRYPTION_KEY` is the only secret a deployment has to bring. It encrypts the provider tokens and TOTP secret stored in D1, so it cannot be generated at runtime and stored there — and because rotating it means reconnecting every account, there is no "set a temporary one now, change it later" either. Generate it once with `openssl rand -hex 32`.

`AUTH_SECRET` (signs sessions and OAuth state) and `SCHEDULER_SECRET` (the tick bearer) are derived from it with HMAC-SHA256, so there is nothing else to invent or keep in sync. Set either one explicitly to override the derivation, and delete it to go back. Changing `AUTH_SECRET` signs everybody out. You need `SCHEDULER_SECRET` only when something outside the Worker has to hold the tick bearer, such as an external pinger (see [Scheduling](#scheduling)).

The login has two modes. Left unset, the account is created in the browser on the first visit and lives in D1 — changed in **Settings → Login**. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (both or neither, as Worker secrets rather than vars) and they stay authoritative instead; the sweep then removes any other user row. Someone else reaching a fresh instance before you can claim it, so set them, or claim it immediately after deploying.

## Putting it behind Cloudflare Access

Optional. The app has its own login, so Access is an extra gate for an instance only you (or a small team) reach — it does not replace the login, and it does not replace the secrets: `APP_ENCRYPTION_KEY` still encrypts your tokens, and `AUTH_SECRET` still signs sessions, OAuth state and media URLs.

If you enable it (Workers → your Worker → **Access**, or the `workers.dev` one-click), three things need exemptions or they break:

- **Media for Meta's crawler.** `/api/media/public/*` must stay reachable without a login, or Threads and Mastodon cannot fetch images. Add a separate Access application for that path with a **Bypass / Include Everyone** policy.
- **Scripts and pingers.** Anything calling the API with a bearer key, or the tick endpoint, needs a **Service Auth** policy and a service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) alongside the app's own key. A bypass policy would also work, but it is neither authenticated nor logged.
- **OAuth callbacks.** If a provider redirects back while your Access session has expired, Access intercepts it before the app sees the code. Bypass `/api/connections/*/callback` if that happens.

The cron trigger is unaffected: the scheduled handler calls the Worker in-process, never over HTTP. Access also requires Zero Trust to be enabled, which asks for payment details even on the free plan (50 users; service tokens do not consume seats), and on `workers.dev` it is set up through the Workers dashboard flow because the Zero Trust domain picker only lists domains from a zone. An account-wide "Protect all Workers" setting applies to new deployments too, and needs the same exemptions.

## Script / app API

The browser UI uses the `sent_session` cookie after TOTP. Scripts, Shortcuts, and cron use a personal API key instead — no login, no cookies. Manage it in **Settings → API access** (generate, rotate, revoke); the raw key is shown once and only its hash is stored. Worked examples for the common calls live in-app at `/api`.

```sh
export APP_URL=https://socialsent.<account>.workers.dev
export SOCIALSENT_API_KEY=sent_...   # from Settings → API access

curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $SOCIALSENT_API_KEY"
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $SOCIALSENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","baseBody":"from a script"}'
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $SOCIALSENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"]}'
```

`X-API-Key` works as an alternative header; never put the key in the URL. The key acts as you on drafts, variants, media, publish, schedule, queue, settings, and reads — but it can never connect or disconnect accounts, or create, rotate, or revoke keys (those stay in the browser session). The global `API_TOKEN` Worker secret still works everywhere for backwards compatibility, but prefer the personal key for scripts: it is revocable without touching the scheduler.

Publishing the same draft and account twice reuses the row. Already-published accounts come back `skipped: true`. A live publish returns `inFlight: true` — wait, then try again. Do not call `/api/targets/:id/retry` unless the row is `failed` (or a stuck `publishing` older than 15 minutes).

Schedule returns **409** if that account is already published or still publishing. Check `error`, `alreadyPublished`, and `inFlight` instead of treating HTTP 200 as "it was scheduled".

## OAuth app setup

Mastodon (per instance) and Bluesky (app password) need no setup. LinkedIn, Threads, and X need apps:

- **LinkedIn**: create an app at the LinkedIn Developer Portal, enable the "Share on LinkedIn" product, add redirect `{APP_URL}/api/connections/linkedin/callback`, then set Worker secrets `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
- **Threads**: create a Meta app with the Threads use case, add redirect `{APP_URL}/api/connections/threads/callback`, then set Worker secrets `THREADS_APP_ID` / `THREADS_APP_SECRET`.
- **X**: create a Project + App at the X Developer Console, enable OAuth 2.0 with type "Web App", add redirect `{APP_URL}/api/connections/x/callback`, then set Worker secrets `X_CLIENT_ID` / `X_CLIENT_SECRET`. Posting uses pay-per-use API credits — fund a small balance in the console first.

Without these, those connect buttons report "not configured" — Mastodon and Bluesky keep working.

## Platforms

| Platform | Auth                                                                     | Text                       | Images                                 | Threads                      |
| -------- | ------------------------------------------------------------------------ | -------------------------- | -------------------------------------- | ---------------------------- |
| Mastodon | OAuth (per instance)                                                     | instance max (default 500) | 4, 16MB                                | yes                          |
| Bluesky  | handle + app password                                                    | 300                        | 4, 1MB                                 | yes                          |
| LinkedIn | OAuth (`openid profile email w_member_social`)                           | 3000                       | 4, 8MB (no WebP)                       | no — flattened into one post |
| Threads  | OAuth (`threads_basic threads_content_publish` `threads_manage_replies`) | 500, max 5 links           | 4 uploadable, 10 allowed, 8MB JPEG/PNG | yes                          |
| X        | OAuth 2.0 + PKCE                                                         | 280, max 1 cashtag         | 4, 5MB (15MB GIF)                      | yes                          |

Threads images are served to Meta via short-lived signed URLs (2h expiry, never linked publicly). Meta's crawler intermittently fails to fetch a URL that works moments later (subcode 2207052), so media containers retry with a freshly signed URL and the failure stays retryable; a custom public media origin can be configured with `MEDIA_PUBLIC_BASE_URL` (for example an R2 custom domain behind Cloudflare's cache) to skip the Worker hop entirely. LinkedIn rejects WebP at publish time — upload JPEG/PNG/GIF.

## Features

- Typefully-style thread editor (cards, images + alt, Main + per-platform tabs)
- Publish now (sync results + retry) or schedule
- Cancel / reschedule / retry from Posts
- Retryable failures (network, rate limits, Meta's media crawler) reschedule themselves with backoff, up to 5 attempts; after that — or on a terminal error — the target parks as Failed
- Disconnect keeps published history (archive) and returns waiting drafts
- Dashboard failure banner plus an optional daily failure-digest email
- Credentials encrypted at rest (AES-256-GCM)
- Threads via `---` segment split (Mastodon / Bluesky / X / Threads; LinkedIn flattens the thread into one post)
- Personal API key for scripts (`Settings → API access`, docs at `/api`)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the checks that must pass, and code expectations. Security issues: [SECURITY.md](SECURITY.md) — please report privately.

## License

MIT
