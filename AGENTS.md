# AGENTS

## Release

Release 작업 시 아래 항목은 필수입니다.

- 웹사이트 landing page의 `new` 문구를 최신 릴리즈 내용으로 업데이트한다. (`site/index.html`)
- npm에 릴리즈 버전을 반드시 publish한다. (메타 패키지 `@siisee11/discode`와 플랫폼 패키지 `@siisee11/discode-*` 모두)
- GitHub Releases 페이지에 릴리즈를 등록하고, changelog를 포함해 배포 아티팩트를 업로드한다.

## Web 배포

- `site/**` 웹 코드를 변경했다면 배포까지 진행한다.
- 배포 명령: `npm run pages:deploy`

## Daemon 재시작

아래 코드를 수정했다면 daemon을 재시작한다.

- `src/index.ts`, `src/daemon-entry.ts`
- `src/capture/**`, `src/discord/**`, `src/tmux/**`, `src/state/**`, `src/config/**`, `src/agents/**`
- 그 외 daemon 실행 경로에서 import되는 `src/**` 파일

아래 변경은 daemon 재시작이 필요 없다.

- `site/**`, `README.md` 등 문서/랜딩 페이지 변경
- `tests/**` 변경
- `scripts/**`만 변경한 경우

주의:

- `discode-src onboard`는 이미 실행 중인 글로벌 daemon을 재사용하므로 코드 변경이 자동 반영되지 않는다.
- 코드 변경 후 아래 명령으로 수동 재시작한다.

```bash
discode-src daemon stop
discode-src daemon start
discode-src daemon status
```
