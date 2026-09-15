# SocialSent

Minimal social scheduler for Mastodon, Bluesky, LinkedIn, Threads, and X. SvelteKit on the Cloudflare stack (Workers, D1, R2).

Write a draft, optionally customize per platform, then publish now or schedule. Bring your own credentials: single-tenant by design, with one admin account on your own Cloudflare account.

## Stack

- SvelteKit 2 + Svelte 5
- Cloudflare Workers + Static Assets
- D1 (SQLite) via Drizzle
- R2 for images
- GitHub Actions (or any cron) calling `/api/internal/tick` for scheduled posts

## Requirements

- Node 22.12+
- A Cloudflare account with Workers, D1, and R2 available. Cloudflare asks for a payment method on file to enable R2, even for free-tier usage.
- Something that can call `/api/internal/tick` on a schedule, if you want scheduled posts to fire. The Workers free plan cannot hold a per-minute cron trigger — see [Scheduling](#scheduling).

## Local

```sh
cp .dev.vars.example .dev.vars
# edit ADMIN_EMAIL, ADMIN_PASSWORD, APP_ENCRYPTION_KEY, AUTH_SECRET
# optional: API_TOKEN for script access (min 16 chars)

npm install
npm run db:migrate:local
npm run dev
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.dev.vars`. Those values are the live login — change `.dev.vars` and restart to change the password. The D1 user row is only an ID for drafts and connections.

First sign-in asks you to enroll an authenticator (Google Authenticator or any TOTP app). Save the backup codes. For friction-free local dev, set `SKIP_TOTP=1` in `.dev.vars` — 2FA is skipped entirely, and the flag is honored only while `APP_URL` is localhost, so it can never disable 2FA in production. Remove it (and restart) to go back to real 2FA.

```sh
npm test          # vitest
npm run check     # svelte-check
npm run build     # production worker + wrap scheduled handler
```

Local `npm run dev` ticks due posts every 30s automatically.

`npm run test:e2e` runs the Playwright suite against a local build of the Worker. It keeps to itself: its D1/R2 state lives in `.wrangler/e2e-state`, so your `npm run dev` data is never touched. If you have no `.dev.vars`, the suite seeds one from `tests/e2e/fixtures/dev.vars` (an existing file is used as-is, so put `SKIP_TOTP=1` in yours to match the path CI takes).

## Deploy

### 1. Create the storage

```sh
npx wrangler d1 create socialsent
npx wrangler r2 bucket create socialsent-media
```

Put the printed `database_id` into `wrangler.jsonc`.

### 2. Set the Worker secrets

These must be Worker secrets, not `[vars]`: a deploy overwrites `vars` with whatever `wrangler.jsonc` says, so anything committed there is public and gets reset on every deploy.

```sh
npx wrangler secret put APP_ENCRYPTION_KEY   # openssl rand -hex 32
npx wrangler secret put AUTH_SECRET          # openssl rand -hex 32
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put APP_URL              # https://socialsent.<account>.workers.dev
npx wrangler secret put API_TOKEN            # openssl rand -hex 32
```

Also set `SCHEDULER_SECRET` (`openssl rand -hex 32`) if you want the tick endpoint to work — see [Scheduling](#scheduling). Optional extras:

```sh
# Public media origin for Meta's crawler (an R2 custom domain behind Cloudflare's cache)
npx wrangler secret put MEDIA_PUBLIC_BASE_URL
# Failure digest via Resend
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put NOTIFY_EMAIL
npx wrangler secret put NOTIFY_FROM
```

Instead of typing these one by one, `npm run secrets:put` uploads the keys it manages from `.dev.vars` (and `.api-token` for `API_TOKEN`). That allowlist covers the app's own secrets — the notification variables above are not in it, set them yourself. It refuses to upload a localhost `APP_URL`.

### 3. Deploy

```sh
npm run deploy
```

`npm run deploy` runs unit tests, applies remote D1 migrations, builds, and deploys the Worker. Worker-only: `npm run deploy:worker`.

### Scheduling

Scheduled posts save to D1 and fire when something calls the tick endpoint. The Workers free plan cannot hold a per-minute cron trigger, so use either an external cron job (cron-job.org, a Raspberry Pi, a systemd timer) or the bundled GitHub Actions workflow, both hitting:

```sh
curl -X POST "$APP_URL/api/internal/tick" \
  -H "Authorization: Bearer $SCHEDULER_SECRET" \
  -H "Content-Type: application/json"
```

Both headers matter: the endpoint takes `SCHEDULER_SECRET` (`API_TOKEN` still works as a fallback; `AUTH_SECRET` never does — it signs sessions and is rejected on the wire), and `Content-Type: application/json` is required because SvelteKit's built-in CSRF guard rejects form-encoded POSTs without an `Origin` header (403) before app code ever runs. Clients that default to a form content type must override it.

`SCHEDULER_SECRET` must be 32+ characters and lives in exactly two places — the Worker secret and the pinger config — so rotate both together. For the GitHub workflow, set repository secrets `APP_URL` and `SCHEDULER_SECRET`. That workflow is scheduled every minute, but GitHub throttles it to roughly one run every two hours, so treat it as a backup. Queue treats a heartbeat older than 6 hours as delayed. You can also run it manually from **Actions → Scheduler tick → Run workflow**.

Never run two per-minute callers plus a Cloudflare cron together. Ticks are idempotent, so overlap is safe, but keep it to one pinger plus the throttled GitHub backup.

On a paid plan you can skip the external pinger: add a cron under `triggers` in `wrangler.jsonc` and set `ENABLE_CF_CRON` to `1` in its `vars`. The Worker ignores scheduled runs until that flag is set, so a leftover trigger cannot double-fire while you switch over.

### Failure alerts (optional)

The dashboard shows a "failed to publish" banner linking to the Failed tab. To also get a morning-after email, set `RESEND_API_KEY` and `NOTIFY_EMAIL` as Worker secrets (the app no-ops without them), plus an optional `NOTIFY_FROM` sender on a domain verified in Resend. At most one digest is sent per 24h window, covering failures newer than the last digest. Posts that are still retrying are not emailed.

### Changing the login later

There is no in-app password form; update the Worker secret:

```sh
npx wrangler secret put ADMIN_PASSWORD
```

Changing `ADMIN_EMAIL` is a bigger deal: the app keeps exactly one user row and deletes any user whose email is not `ADMIN_EMAIL`, so the old row (and everything cascading from it — drafts, connections, sessions) is removed on the next request. Change it deliberately, and expect to reconnect your accounts.

## Keeping your own deployment separate from upstream

If you run your own instance while pulling updates from this repo, keep your instance-specific values in `wrangler.personal.jsonc` (gitignored) instead of editing `wrangler.jsonc`. Copy the committed file and change `name`, `database_id`, `database_name`, and `bucket_name`.

Every npm script goes through `scripts/wrangler.mjs`, which passes `--config wrangler.personal.jsonc` automatically when that file exists, plus `--profile <name>` when `WRANGLER_PROFILE` is set:

```sh
WRANGLER_PROFILE=my-account npm run deploy
```

Because your changes live in files upstream never touches, `git pull upstream main` stays conflict-free.

## Naming your instance

`APP_NAME` (a plain `[vars]` entry, default `SocialSent`) is shown in the page title, the header, and the login screen. Set it to whatever you like — the outbound `User-Agent`, the Mastodon app name, cookies, and API-key prefixes stay fixed so upgrades keep working.

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
