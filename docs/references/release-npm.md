# npm Release Reference

Canonical for: publishing the `@siisee11/discode` npm package set
Audience: maintainers preparing an npm release
Update when: packaging layout, publish commands, or verification steps change

## Pre-check

- Confirm the npm account has publish access under `siisee11`
- Prefer an npm automation token when 2FA is enabled
- Never store tokens in the repository or commit history

```bash
cd /Users/dev/git/discode
npm whoami
npm token list
```

If needed:

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_AUTOMATION_TOKEN
npm whoami
```

## Versioning

Update all package versions together in [package.json](/Users/dev/git/discode/package.json):

- `version`
- every `optionalDependencies["@siisee11/discode-*"]` entry

## Build and Package

```bash
npm run typecheck
npm run build
npm run build:release
npm run pack:release
```

Artifacts are produced under `dist/release/`.

## Publish Order

1. Publish every generated platform package under `dist/release/**` except the meta package.
2. Publish the meta package at `dist/release/npm/discode`.

```bash
find dist/release -name package.json -not -path "*/npm/discode/*" | while read -r pkg; do
  dir="$(dirname "$pkg")"
  npm publish --access public --workspaces=false "$dir"
done

npm publish --access public --workspaces=false dist/release/npm/discode
```

## Verify

```bash
npm view @siisee11/discode version
npm view @siisee11/discode-darwin-arm64 version
npm view @siisee11/discode-linux-x64 version
npm view @siisee11/discode-runtime-client-darwin-arm64 version
npm view @siisee11/discode-daemon-rs-darwin-arm64 version
npm view @siisee11/discode-pty-sidecar-darwin-arm64 version

npm i -g @siisee11/discode@latest
discode --version
```

## Common Failures

- `EOTP`: use an automation token or adjust npm 2FA policy
- `You cannot publish over the previously published versions`: bump the version and rebuild
- `Access token expired or revoked`: refresh npm auth and retry
