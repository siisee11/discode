# Release Procedure

Canonical for: repository release obligations
Audience: maintainers preparing a versioned release
Update when: packaging, web, or GitHub release steps change

Every release must include all of the following:

1. Update the landing page `new` copy in `site/index.html` to reflect the latest release.
2. Publish the npm release for the meta package `@siisee11/discode`.
3. Publish the npm release for all platform packages `@siisee11/discode-*`.
4. Create a GitHub Release with changelog text and uploaded release artifacts.

Detailed npm packaging steps currently live in the Korean guide [`../RELEASE_NPM.ko.md`](../RELEASE_NPM.ko.md).

Related operational documents:

- Web deployment: [`web-deploy.md`](web-deploy.md)
- Reliability context: [`../RELIABILITY.md`](../RELIABILITY.md)
