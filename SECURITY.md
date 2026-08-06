# Security Policy

## Protecting credentials

Arena Hero API keys must only be stored in the local `.env` file. Do not place a real key in source files, examples, issues, screenshots, logs, releases, or Git commits.

The repository ignores `.env`, runtime state, logs, caches, and virtual environments. Before publishing a fork, run a credential scan over the files Git intends to commit.

Run `scripts/verify.cmd` before every commit or release. It invokes `scripts/security_check.ps1`, which scans Git upload candidates for common tokens, private keys, personal email addresses, local usernames, computer names, absolute home paths, private IP addresses, sensitive exports, and embedded remote credentials. Findings include only the file, line number, and rule name; matched values are never printed.

Git commits permanently include an author name and email address. Configure repository-local identity values that you are comfortable publishing before the first commit. Review the GitHub remote URL before pushing and never embed a username, password, or token in it.

## Accidental disclosure

If a key is committed or shared, revoke it immediately in the Arena Hero account, create a replacement, remove the exposed value from Git history, and update the local `.env` file. Do not rely on deleting the file in a later commit because the original value remains in Git history.

## Reporting

Security reports should describe the affected file and behavior without including a working credential or personal game data.
