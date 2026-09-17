# Deploying SocialSent

Three ways to get an instance running, and what to do when one of them breaks.
Everything here assumes a Cloudflare account with Workers, D1 and R2 available;
R2 asks for a payment method on file even on the free tier.

## Pick a path

| Path                                       | Terminal | GitHub integration   | Best for                                           |
| ------------------------------------------ | -------- | -------------------- | -------------------------------------------------- |
| [One command](#one-command)                | yes      | no                   | the reliable default, and what CI-like setups want |
| [Step by step](#step-by-step)              | yes      | optional             | doing it by hand, or debugging an unusual setup    |
| [Deploy to Cloudflare button](#the-button) | no       | yes (Workers Builds) | push-to-deploy without touching a terminal         |

### One command

```sh
git clone --depth 1 --branch stable https://github.com/deepakness/social-sent.git sent
cd sent && npm install && npm run setup
```

No GitHub App, no Workers Builds, nothing to configure in a browser beyond the
`wrangler login` that `setup` starts. It creates the D1 database and the R2
bucket if they are missing, generates `APP_ENCRYPTION_KEY`, writes it to
`.dev.vars` and to the Worker, applies migrations, deploys, and pins `APP_URL`
to the URL it deployed to.

Re-running is safe, and `npm run setup -- --dry-run` prints the plan without
touching anything.

### The button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/deepakness/social-sent)

The README explains every field it shows. Two things about it are worth knowing
before you start:

- It needs the **Cloudflare Workers and Pages** GitHub App, and Cloudflare has
  to hold its own link to that installation — installing it on GitHub alone is
  not enough.
- The initial build clones this repository itself (a "seed" build). Those builds
  **cannot be retried** from the dashboard, so a failure in that step means
  starting the deploy again or switching to another path.

If it fails for either reason, see [GitHub authorization](#your-github-authorization-has-expired)
and [the seed build](#source-repo-failed-to-clone-exit-code-128) below.

### Step by step

The README walks through `d1 create`, `r2 bucket create`, the Worker secrets and
the first deploy. Keep using `scripts/wrangler.mjs` instead of plain
`npx wrangler` so your `wrangler.personal.jsonc` and `WRANGLER_PROFILE` apply.

### Push-to-deploy, without Workers Builds

Copy `.github/workflows/deploy.yml.example` to `.github/workflows/deploy.yml`
and add two repository secrets — `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 and
R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then build
and deploy from GitHub's runners. That workflow skips itself when the secrets
are missing, so forks stay quiet.

## After the first deploy

1. Open the Worker URL — the app sends you to `/setup`. Create the account
   (any email and password you like) and save the TOTP backup codes.
2. Connect accounts under **Accounts**. Mastodon works immediately; LinkedIn,
   Threads and X need an OAuth app each, with the redirect URI built from your
   deployed URL (README → _OAuth app setup_).
3. Scheduled posts publish themselves through the cron trigger in
   `wrangler.jsonc`. Nothing to set up unless you want an external pinger, in
   which case set `SCHEDULER_SECRET` and keep both copies in sync.
4. Optional: `RESEND_API_KEY` + `NOTIFY_EMAIL` for failure digests, and the
   instance name under **Settings → Instance**.

## Check it worked

```sh
npm run doctor
npm run doctor -- --app-url https://your-worker.workers.dev
```

Read-only: it verifies your login, that the D1 database and R2 bucket exist,
that `APP_ENCRYPTION_KEY` is set, whether migrations are pending, whether the
Worker has a deployment, and — with `--app-url` — that the app answers
`/api/health` and the scheduler is alive. Every failure prints the exact command
that fixes it. It never changes anything.

## Troubleshooting

### "Your GitHub authorization has expired"

The Cloudflare Workers and Pages GitHub App lost its authorization, or
Cloudflare's link to that installation went stale. Reinstalling on GitHub alone
does not fix it — you have to re-link it from Cloudflare:

1. GitHub → <https://github.com/settings/installations> (or the organisation's
   settings) → **Cloudflare Workers and Pages** → **Configure**. Set
   **Repository access** to _All repositories_ while you are debugging, and
   **Save**.
2. Cloudflare → **Workers & Pages** → **Create application** → **Workers** →
   **Connect to Git** → **+ Add account** → pick your GitHub account →
   **Install & Authorize**.
3. Retry the deploy.

If it keeps expiring: check you are signed into the same GitHub account in that
browser, that the app is installed on the right account (personal vs
organisation), and that an organisation with SAML SSO has the app authorised.
An account that is already linked to another Cloudflare account can also be
refused — use a GitHub organisation or a second GitHub account for one of them.

### "source repo failed to clone" (exit code 128)

The first step of the button flow clones the seed repository through the GitHub
App token. Just after a reinstall that token can still be the old one, so:

1. Click **Deploy** again in the form — this starts a fresh build rather than
   retrying (see the next point).
2. Check **Workers & Pages → your Worker → Settings → Builds → Git repository**
   says _Manage_ for the right repository. If it shows a warning, disconnect and
   reconnect.
3. Still failing? The button created a repository in your account already. Push
   this code into it and connect the Worker through the ordinary Git
   integration, which has no seed step:

   ```sh
   git clone https://github.com/deepakness/social-sent.git sent
   cd sent
   git remote add mine https://github.com/<you>/<the-repo-the-button-created>.git
   git push mine main
   ```

   Then **Workers & Pages → Create application → Workers → Import a
   repository** → pick that repository → build `npm run build`, deploy
   `npm run deploy` → **Save and Deploy**. These builds can be retried, and
   pushes deploy automatically.

   One difference: the import flow does not collect secrets, so set
   `APP_ENCRYPTION_KEY` yourself under the Worker's **Settings → Variables and
   Secrets**, or skip GitHub entirely and use the one-command path above.

### "Cannot retry a build that was created with a seed_repo override"

Expected: Cloudflare refuses to retry the button's initial build. Re-run the
deploy from the form, or switch to the import path above — those builds retry
normally.

### The R2 step says the bucket name already exists

R2 bucket names are unique across all Cloudflare accounts, so `socialsent-media`
is only a starting point. Change the name in the form (nothing in the app
depends on it) or set `bucket_name` in `wrangler.personal.jsonc` before
deploying. R2 also refuses to create anything until the account has a payment
method on file, even for free-tier usage.

### The app answers 503: "must not be an example value"

The deployment is running on the example secrets from `.dev.vars.example`. Set
real ones and redeploy:

```sh
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY   # openssl rand -hex 32
npm run deploy
```

`npm run doctor -- --app-url <url>` reports this case directly.

### Which URL is my instance on?

Cloudflare dashboard → **Workers & Pages** → your Worker → the URL on the
overview page, or **Settings → Domains & Routes**. `npm run setup` prints it
too, and stores it as `APP_URL`.

### A custom domain

Add it under **Settings → Domains & Routes → Add → Custom Domain**. Nothing else
is needed: the app uses the origin each request arrives on, and OAuth callbacks
are built from it. If you previously pinned `APP_URL` to the `workers.dev`
address, update or delete that secret so the new hostname is used.

### Scheduled posts never fire

Check the Worker's **Settings → Triggers** for the `* * * * *` cron, then look at
the dashboard in the app — it shows the last scheduler heartbeat. The tick needs
`SCHEDULER_SECRET` (or `API_TOKEN`) to authenticate when it is called from
outside; the built-in cron derives its own credential from
`APP_ENCRYPTION_KEY`. Read-only check:

```sh
npm run doctor -- --app-url <url>   # reports the scheduler line
```

### Missing migrations

After pulling new code:

```sh
npm run db:migrate:remote
npm run deploy
```

or `npm run deploy:release`, which runs tests, migrations, build and deploy in
one go.

### Two instances in one Cloudflare account

Give the second instance its own names, or it will adopt the first one's
resources: D1 provisioning matches on `database_name`, and R2 bucket names are
global. `npm run setup -- --name my-sent --db my-sent --bucket my-sent-media`
writes them into `wrangler.personal.jsonc` (gitignored).

### Updating, and rolling back

```sh
git pull                     # or: git pull upstream main for a button-created copy
npm ci
npm run deploy:release
```

To move between releases, check out the tag you want (`git tag` lists them) and
deploy again. `stable` is the branch behind the recommended one-command install.

### Starting over

Worker, D1 database and R2 bucket can be deleted from the dashboard; the
`wrangler.personal.jsonc` and `.dev.vars` files hold the only local state. A
fresh clone plus `npm run setup` then rebuilds everything.

## Still stuck?

Open an issue with the output of `npm run doctor` and the version shown in
**Settings → Instance**.
