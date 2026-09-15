# Contributing

Thanks for taking a look. This is a single-tenant app (one admin account on your own Cloudflare account), so most contributions are provider fixes, UI work, or tests.

## Getting set up

```sh
git clone <your fork>
cd social-sent
npm install
cp .dev.vars.example .dev.vars   # then generate real values, see below
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

`.dev.vars` needs `APP_URL`, `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`), `AUTH_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Generate your own keys — the example file ships deliberate placeholders, and the app refuses to start with them unless `APP_URL` points at localhost.

Set `SKIP_TOTP=1` to skip the authenticator dance while developing. It is honored only for a localhost `APP_URL`, so it can never weaken a deployment.

## Checks

```sh
npm test          # vitest unit + integration tests
npm run test:e2e  # Playwright smoke suite against a local build
npm run check     # svelte-check
npm run lint      # prettier --check + eslint
npm run build     # production worker
```

All five must pass. `npm run format` fixes formatting.

The e2e suite runs against its own local D1/R2 state (`.wrangler/e2e-state`) and never touches the state behind `npm run dev`. If you have no `.dev.vars`, the suite seeds one from `tests/e2e/fixtures/dev.vars`; an existing one is left alone, so make sure it sets `SKIP_TOTP=1` if you want the same path CI takes.

## Code expectations

- **Comments explain why, not what.** The existing files are a good reference: comment the protocol quirk, the retry rule, or the failure mode you are working around — not the syntax.
- **Keep provider code inside `src/lib/server/providers/`** behind the shared `Provider` interface, so a new platform cannot drift from the others.
- **No new dependencies without a reason.** The runtime dependency list is deliberately small.
- **Tests for behavior, not for mocks.** Assert what the app does, not that a spy was called.

## Pull requests

- One logical change per PR, conventional-commit title (`fix(threads): …`, `feat(editor): …`).
- Say what you changed and why in the body; include the failing case you fixed when there is one.
- Update the README when behavior or configuration changes.
- Provider changes: mention which platform you tested against and with what account type.

## Security

Please do not open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your work is licensed under the [MIT License](LICENSE).
