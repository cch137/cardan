# Releasing cardan

cardan is developed in the [`cch137/raven`](https://github.com/cch137/raven)
monorepo under `packages/cardan/` and mirrored to the public
[`cch137/cardan`](https://github.com/cch137/cardan) repo via `git subtree`.
**All releases are cut from the monorepo** — the public repo is a one-way
mirror and must never be edited directly.

## Prerequisites (one-time)

- The public repo `github.com/cch137/cardan` exists and the monorepo has a
  `cardan` remote pointing at it (see [`docs/cardan-subtree.md`](https://github.com/cch137/raven/blob/main/docs/cardan-subtree.md)).
- You are logged in to npm (`npm whoami`) with publish rights to `cardan`.

## Steps

1. **Bump the version** in `package.json` (follow semver) and commit it along
   with any release notes.
2. **Commit everything** — the working tree under `packages/cardan/` must be
   clean. Generated `dist/` is git-ignored and rebuilt during the release.
3. **Sync the public mirror:**

   ```bash
   git subtree push --prefix=packages/cardan cardan main
   ```

   Wait for the public repo's CI to go green.
4. **Run the release gate** from `packages/cardan/`:

   ```bash
   npm run release -- --dry-run   # full checklist, publishes nothing
   npm run release                # publish for real (prompts to confirm)
   ```

   The script (`bin/publish.mjs`) refuses to publish unless:
   - the package working tree is clean (source + metadata committed),
   - the `cardan/main` mirror is in sync with `HEAD:packages/cardan`,
   - the version is new and ordered correctly against the npm registry,
   - typecheck / test / build pass and leave the tree clean,
   - the tarball includes `dist/`, `DESIGN.md`, `README.md`, `LICENSE` and
     leaks no `src/`/`test/`/raw `.ts`.
5. **Push the monorepo branch** (`git push origin <branch>`) and tag the
   release if desired.

## Flags

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Run all checks + `npm publish --dry-run`; never publishes. |
| `--yes`, `-y` | Skip the confirmation prompt. |
| `--tag <tag>` | dist-tag (default `latest`); non-latest relaxes the ordering check. |
| `--otp <code>` | npm 2FA one-time password. |
| `--allow-dirty` | Permit uncommitted changes (downgrades clean checks to warnings). |
| `--remote <name>` | Public mirror remote (default `cardan`). |
| `--branch <name>` | Public mirror branch (default `main`). |
| `--skip-subtree-check` | Skip the subtree-sync verification (use with care). |
