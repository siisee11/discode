# Discode npm 배포 가이드

`discode`를 플랫폼 바이너리 패키지 + 메타 패키지(`@siisee11/discode`) 방식으로 배포하는 절차입니다.

## 1) 사전 준비

- npm 로그인 계정이 `siisee11`인지 확인
- npm 2FA가 켜져 있으면 **Automation token** 사용 권장
- 절대 토큰을 저장소/커밋/채팅에 평문으로 남기지 않기

```bash
cd /Users/dev/git/discode
npm whoami
npm token list
```

Automation token 등록:

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_AUTOMATION_TOKEN
npm whoami
```

## 2) 버전 올리기

`package.json`의 아래 버전을 동일하게 올립니다.

- `version`
- `optionalDependencies` 안의 `@siisee11/discode-*` 버전들

예: `0.1.1` -> `0.1.2`

## 3) 빌드/패키징

```bash
npm run typecheck
npm run build
npm run build:release
npm run pack:release
```

산출물:

- 플랫폼 패키지: `dist/release/discode-*`
- runtime-client 패키지: `dist/release/runtime-client/discode-runtime-client-*`
- daemon-rs 패키지: `dist/release/daemon/discode-daemon-rs-*`
- pty-sidecar 패키지: `dist/release/sidecar/discode-pty-sidecar-*`
- 메타 패키지: `dist/release/npm/discode`

## 4) 바이너리 패키지 배포

`dist/release/**` 아래의 `package.json`이 있는 패키지 디렉토리를 모두 publish합니다.
(`dist/release/npm/discode` 메타 패키지는 다음 단계에서 별도로 publish)

```bash
find dist/release -name package.json -not -path "*/npm/discode/*" | while read -r pkg; do
  dir="$(dirname "$pkg")"
  npm publish --access public --workspaces=false "$dir"
done
```

## 5) 메타 패키지 배포

```bash
npm publish --access public --workspaces=false dist/release/npm/discode
```

## 6) 배포 확인

```bash
npm view @siisee11/discode version
npm view @siisee11/discode-darwin-arm64 version
npm view @siisee11/discode-linux-x64 version
npm view @siisee11/discode-runtime-client-darwin-arm64 version
npm view @siisee11/discode-daemon-rs-darwin-arm64 version
npm view @siisee11/discode-pty-sidecar-darwin-arm64 version
```

설치 확인:

```bash
npm i -g @siisee11/discode@latest
discode --version
```

## 문제 해결

### `EOTP` 에러

- 토큰이 Automation token이 아닌 경우 발생 가능
- npm 계정 2FA 정책이 `auth-and-writes`이면 OTP를 계속 요구할 수 있음
- 해결: Automation token 재발급 후 `npm config set ...:_authToken=...`

### `You cannot publish over the previously published versions`

- 같은 버전으로 재배포 시 정상 에러
- 해결: 버전 올리고 다시 빌드/배포

### `Not found` / `Access token expired or revoked`

- 토큰 만료/폐기 또는 인증 꼬임
- 해결: `npm whoami` 재확인, 토큰 재설정

## 릴리즈 후 권장 작업

- `git add` + `commit`으로 버전/배포 스크립트 변경 이력 정리
- 사용한 토큰은 필요시 revoke 후 재발급
