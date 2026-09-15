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
