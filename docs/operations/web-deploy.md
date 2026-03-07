# Web Deployment

Canonical for: deploying the landing page and static docs site
Audience: contributors who changed `site/**`
Update when: the deployment command or web hosting target changes

Rule:

- if `site/**` changes, deploy the web assets as part of the task

Deployment command:

```bash
npm run pages:deploy
```

This procedure exists separately from the release checklist because site-only updates can require deployment without a package release.
