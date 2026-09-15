# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue:

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability), or
- email **me@deepakness.com**

Include what you did, what you expected, and what happened. A proof of concept or a copy of the request helps a lot. You will get an acknowledgement, and credit in the fix's commit or advisory if you want it.

## What this app stores

Worth knowing before you report something:

- **Third-party OAuth credentials** (Mastodon, Bluesky, LinkedIn, Threads, X) in D1, encrypted with AES-256-GCM under `APP_ENCRYPTION_KEY`.
- **A TOTP secret and backup codes** for the single admin account, encrypted the same way.
- **Draft content and uploaded media** (R2). Media handed to Meta is served through short-lived signed URLs.

Anything that exposes those — a key leak, a way to read another tenant's row, an SSRF, a signature bypass — is a real finding. Note that this is a **single-tenant, self-hosted** app: "another user's data" generally means another _deployment_, not another account on one instance.

## Not vulnerabilities

- Missing hardening headers on a self-hosted instance where you control the config.
- Anything requiring an already-compromised `APP_ENCRYPTION_KEY` or `AUTH_SECRET`.
- The deliberately permissive local-dev escape hatches (`SKIP_TOTP`, localhost Mastodon hosts). Both are gated on `APP_URL` pointing at localhost.

## Supported versions

The `main` branch is the only supported version; fixes are not backported.

## Recommended hardening for your own instance

- **Rate-limit the public routes at the edge** (Cloudflare → Security → WAF → Rate limiting rules): `/api/auth/login`, `/api/internal/tick`, and `/api/health` are reachable without a session. Login already locks out after repeated failures, and the other two do little work per hit, but a rate limit is the right place to absorb a flood.
- Keep `SKIP_TOTP` and localhost Mastodon hosts off outside local development — both are gated on `APP_URL` pointing at localhost, so a real deployment never enables them by accident.

The app itself does not throttle requests: it is built for a single person, and an in-Worker counter without a Durable Object or KV binding would be security theatre rather than a defence.
