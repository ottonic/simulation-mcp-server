# Contributing

Thanks for your interest in Simulation MCP Server. The project is MIT licensed; by
contributing you agree to the terms below.

## Development

```sh
just check             # fmt-check, lint, typecheck, unit tests (no solver needed)
just test-integration  # native Gmsh/Elmer tests (full dev shell)
```

The fast checks run in the lightweight `checks` shell; the native tests need the
full toolchain. See the [README](README.md) for setup and supported physics.

## Before you open a pull request

- Run `just check`, and `just test-integration` for solver-affecting changes.
- Keep a change focused: one topic per pull request.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Add or update tests and documentation for behaviour changes.

## Sign-off (Developer Certificate of Origin)

Every commit must be signed off, certifying you have the right to submit it under
this project's license:

```sh
git commit -s -m "feat: ..."
```

This appends a `Signed-off-by:` line. The full text is at
<https://developercertificate.org>.

## License grant

By submitting a contribution, you license it to the project under the MIT License
and grant Matt Mohandiss a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable, sublicensable license to use, reproduce, modify, distribute, and
relicense your contribution, including under different terms. You retain
copyright to your contribution.

## Releasing

Releases are automated with
[release-please](https://github.com/googleapis/release-please) from conventional
commits on `main`: it opens a release PR that bumps `package.json` and
`server.json`; merging it tags the release and publishes to npm and the MCP
registry.

Two one-time maintainer steps:

1. Add a `RELEASE_PLEASE_TOKEN` repository secret — a classic PAT with
   `contents:write` and `pull_requests:write`, so release-please PRs trigger CI.
2. Publish the package to npm once by hand (`npm publish --access public`), then
   configure a **trusted publisher** for this repository on npmjs.com so later
   releases publish without a token.
