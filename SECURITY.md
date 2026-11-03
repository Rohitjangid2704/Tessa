# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository page, Security, **Report a vulnerability**.

Include what you found, how to reproduce it and what an attacker could do with it. You will get an answer within a week.

## Scope

Tessa holds encrypted secrets of the apps it tests and drives real browsers and requests against them. Reports about any of these are especially welcome:

- reading a stored secret or an environment value through the API, logs, reports or artifacts,
- a personal token working after it was revoked or expired,
- a viewer or member doing what only an admin may do,
- a bundle, a scenario or a model output that runs code or reaches hosts it should not,
- prompt injection through an app under test that changes what Tessa or the Claude Code plugin does.

## Running Tessa safely

- Every value that starts with `dev-only-` in this repository is public. Replace them before you expose Tessa on a network, as [Accounts and secrets](docs/05-accounts-and-secrets.md#before-anyone-else-can-reach-your-tessa) describes, and set `TESSA_ENV=prod`.
- Point Tessa at QA or local deployments, never at production.
- Give the oracle connections a read-only database user.
