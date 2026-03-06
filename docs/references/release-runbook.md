# Release Runbook

Audience:
- Maintainers publishing a Discode release

Canonical for:
- Maintainer release workflow
- npm publishing order
- Landing page release note update
- Web deploy trigger for `site/**` changes
- GitHub Releases publication

## Required Steps

1. Update release versioning in `package.json`.
   Keep `version` and the relevant `optionalDependencies` versions aligned.
2. Update the landing page `new` copy in `site/index.html` to describe the latest release.
3. Build and package the release artifacts.

```bash
npm run typecheck
npm run build
npm run build:release
npm run pack:release
```

4. Publish generated npm packages.

- Publish every generated platform package under `dist/release/` before publishing the meta package.
- The meta package is `@siisee11/discode` from `dist/release/npm/discode`.
- A release is not complete until both the meta package and the generated `@siisee11/discode-*` platform packages are published.

Example publish loop:

```bash
find dist/release -name package.json -not -path "*/npm/discode/*" | while read -r pkg; do
  dir="$(dirname "$pkg")"
  npm publish --access public --workspaces=false "$dir"
done

npm publish --access public --workspaces=false dist/release/npm/discode
```

5. Verify published versions.

```bash
npm view @siisee11/discode version
npm i -g @siisee11/discode@latest
discode --version
```

6. If the release changed `site/**`, deploy the site.

```bash
npm run pages:deploy
```

7. Create a GitHub Release with:

- release notes / changelog
- uploaded release artifacts

## Preflight

- Confirm npm publish access under `siisee11`.
- Use an npm automation token if 2FA is enabled.
- Never store or commit npm tokens.

## Update Triggers

Update this runbook when:

- Release packaging or publish order changes
- GitHub Release requirements change
- Site deployment is no longer tied to `site/**` changes
