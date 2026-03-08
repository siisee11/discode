# Discode: Claude → Slack 메시지 Hook 흐름 문서

## 개요

Discode는 Claude Code의 세션 이벤트를 Slack 채널로 실시간 전달하는 브릿지 시스템이다.
Claude 플러그인의 Hook 스크립트가 이벤트를 캡처하고, HTTP로 Bridge Server에 전달하면,
이벤트 파이프라인이 핸들러를 통해 Slack API를 호출한다.

```
Claude Plugin Hook Scripts
        │
        │  POST /opencode-event (HTTP, JSON)
        ▼
BridgeHookServer (port 18471)
        │
        ▼
HookEventPipeline
   ├─ 이벤트 검증 & 컨텍스트 해석
   ├─ 채널별 큐에 직렬화
   └─ 핸들러 디스패치
        │
        ▼
Event Handlers → SlackClient (MessagingClient) → Slack API
```

---

## 1. Hook 스크립트 (이벤트 소스)

Claude Code는 특정 시점에 등록된 hook 스크립트를 실행한다. 각 스크립트는 stdin으로 입력을 받고, HTTP POST로 Bridge Server에 이벤트를 전달한다.

| Hook 스크립트 | 파일 위치 | 발생 시점 | 생성하는 이벤트 |
|---|---|---|---|
| `discode-session-hook.js` | `src/claude/plugin/scripts/` | 세션 시작/종료 | `session.start`, `session.end` |
| `discode-stop-hook.js` | `src/claude/plugin/scripts/` | 세션 유휴 상태 진입 | `session.idle` |
| `discode-tool-hook.js` | `src/claude/plugin/scripts/` | 도구 실행 완료 후 | `tool.activity` |
| `discode-notification-hook.js` | `src/claude/plugin/scripts/` | 알림 발생 시 | `session.notification` |
| `discode-subagent-hook.js` | `src/claude/plugin/scripts/` | 서브에이전트 완료 시 | `tool.activity` (SUBAGENT_DONE) |

### 공통 페이로드 구조

모든 hook이 Bridge에 전송하는 기본 구조:

```json
{
  "projectName": "my-project",
  "agentType": "claude",
  "instanceId": "optional-instance-id",
  "type": "session.start | session.end | session.idle | tool.activity | session.notification"
}
```

환경변수 `DISCODE_PORT` (기본 18470), `DISCODE_HOSTNAME` (기본 127.0.0.1)으로 Bridge 주소를 결정한다.

---

## 2. 이벤트 유형별 상세

### 2.1 `session.start` — 세션 시작

**소스**: `discode-session-hook.js` (Claude SessionStart hook)

**페이로드**:
```json
{
  "type": "session.start",
  "source": "manual",
  "model": "claude-opus-4-6"
}
```

**Slack 전달 흐름**:
1. `handleSessionStart()` 핸들러가 처리
2. `source`가 `"startup"`이면 무시 (초기 부팅 이벤트 필터링)
3. 채널에 시작 메시지 전송 → 이 메시지가 해당 세션의 **스레드 부모 메시지**가 됨
4. `PendingEntry`에 메시지 ID 저장 (이후 모든 스레드 답장의 기준점)
5. 5초 lifecycle 타이머 설정 — 후속 이벤트가 없으면 자동 완료 처리

**Slack 메시지 예시**:
```
▶️ Session started (claude-opus-4-6)
```

---

### 2.2 `session.end` — 세션 종료

**소스**: `discode-session-hook.js` (Claude SessionEnd hook)

**페이로드**:
```json
{
  "type": "session.end",
  "reason": "user_exit"
}
```

**Slack 전달 흐름**:
1. `handleSessionEnd()` 핸들러가 처리
2. 채널에 종료 메시지 전송

**Slack 메시지 예시**:
```
⏹️ Session ended (user_exit)
```

---

### 2.3 `session.idle` — 응답 완료 (메인 응답 전달)

**소스**: `discode-stop-hook.js` (Claude Stop hook)

가장 복잡한 이벤트. Claude가 응답을 완료하고 유휴 상태에 진입하면 발생한다.

**페이로드**:
```json
{
  "type": "session.idle",
  "text": "최종 응답 텍스트",
  "turnText": "턴 전체 텍스트 (파일 경로 추출용)",
  "intermediateText": "도구 호출 전 중간 텍스트",
  "thinking": "Claude 내부 추론 블록",
  "promptText": "AskUserQuestion/ExitPlanMode 포맷팅된 텍스트 (폴백용)",
  "promptQuestions": [{"question":"...", "header":"...", "options":[{"label":"...", "description":"..."}]}],
  "planFilePath": "/path/to/plan.md"
}
```

**Stop Hook의 트랜스크립트 파싱**:
- 트랜스크립트 파일의 마지막 부분을 읽어 라인별 JSON 파싱
- `displayText`: 최신 메시지 ID의 텍스트 (사용자에게 표시되는 것)
- `intermediateText`: 이전 메시지 ID의 텍스트 (도구 호출 사이의 텍스트)
- `thinking`: thinking 블록의 내용
- 시스템 주입 메시지 필터링 (`<system-reminder>`, `[Request interrupted]` 등)
- 재시도 로직: 트랜스크립트 쓰기 지연을 위해 최대 3회, 150ms 간격으로 재시도

**Slack 전달 흐름** (`handleSessionIdle()` → 여러 함수 순차 호출):

```
handleSessionIdle()
  │
  ├─ 1. 타이머 정리 (thinking, lifecycle, thread activity)
  │
  ├─ 2. buildFinalizeHeader(usage)
  │     → "✅ Done · 15,234 tokens · $0.12"
  │     → 스트리밍 메시지를 이 헤더로 최종 업데이트
  │
  ├─ 3. postIntermediateTextAsThreadReply()
  │     → 중간 텍스트를 스레드 답장으로 전송
  │     → 3900자 단위 분할 (Slack 제한)
  │
  ├─ 4. postThinkingAsThreadReply()
  │     → 12,000자로 잘라서 코드 블록으로 감싸기
  │     → "🧠 *Reasoning*\n```\n{사고 내용}\n```"
  │     → 스레드 답장으로 전송
  │
  ├─ 5. postUsageAsThreadReply()
  │     → "📊 Input: 10,000 · Output: 5,234 · Cost: $0.12"
  │     → 스레드 답장으로 전송
  │
  ├─ 6. postResponseText()
  │     → turnText에서 파일 경로 추출
  │     → 텍스트에서 파일 경로 제거 (표시용)
  │     → 채널에 메인 응답 전송 (3900자 단위 분할)
  │
  ├─ 7. postResponseFiles()
  │     → 추출된 파일 경로 검증 (프로젝트 내 존재 여부)
  │     → filesUploadV2 API로 파일 업로드
  │
  └─ 8. postPromptChoices()
        → promptQuestions 있으면: sendQuestionWithButtons() (인터랙티브 버튼, fire-and-forget)
           → 사용자 클릭 시 선택값이 messageCallback으로 Claude에 자동 전달
        → ExitPlanMode + planFilePath인 경우: 플랜 파일 첨부 전송
        → 그 외: promptText를 텍스트로 분할 전송
```

**Slack 메시지 예시 (채널)**:
```
응답 텍스트가 여기에 표시됩니다. 파일 경로는 제거되고
별도로 파일이 업로드됩니다.
```

**Slack 메시지 예시 (스레드)**:
```
📊 Input: 10,000 · Output: 5,234 · Cost: $0.12
```
```
🧠 *Reasoning*
```claude thinking content```
```

---

### 2.4 `tool.activity` — 도구 실행 활동

**소스**: `discode-tool-hook.js` (Claude PostToolUse hook)

Claude가 도구를 사용할 때마다 실시간으로 발생한다.

**페이로드**:
```json
{
  "type": "tool.activity",
  "text": "📖 Read(`src/main.ts`)"
}
```

**도구별 포맷팅** (hook 스크립트 내에서):

| 도구 | 포맷 | 예시 |
|---|---|---|
| Read | `📖 Read(\`경로\`)` | `📖 Read(\`src/bridge/hook-server.ts\`)` |
| Edit | `✏️ Edit(\`경로\`) +N lines - "미리보기"` | `✏️ Edit(\`src/main.ts\`) +5 lines - "const x = 1"` |
| Write | `📝 Write(\`경로\`) N lines` | `📝 Write(\`new-file.ts\`) 120 lines` |
| Bash | `` 💻 \`명령어\` `` | `` 💻 \`npm test\` `` |
| Grep | `🔍 Grep(\`패턴\` in 경로)` | `🔍 Grep(\`handleEvent\` in src/)` |
| Glob | `📂 Glob(\`패턴\`)` | `📂 Glob(\`**/*.test.ts\`)` |
| WebSearch | `🌐 Search(\`쿼리\`)` | `🌐 Search(\`vitest mock patterns\`)` |
| WebFetch | `🌐 Fetch(\`URL\`)` | `🌐 Fetch(\`https://docs.example.com\`)` |
| TaskCreate | `TASK_CREATE:{...}` | 구조화 이벤트 (아래 참조) |
| TaskUpdate | `TASK_UPDATE:{...}` | 구조화 이벤트 (아래 참조) |

**Git 감지** (Bash 도구 응답에서):
- `GIT_COMMIT:{"hash":"abc1234","message":"fix bug","stat":"1 file changed"}`
- `GIT_PUSH:{"toHash":"abc1234","remoteRef":"origin/main"}`

**Slack 전달 흐름** (`handleToolActivity()`):

```
handleToolActivity()
  │
  ├─ lifecycle 타이머 취소
  │
  ├─ 구조화 이벤트 감지 (텍스트 prefix 기반)
  │   ├─ TASK_CREATE: / TASK_UPDATE: → handleTaskProgress()
  │   ├─ GIT_COMMIT: / GIT_PUSH:    → handleGitActivity()
  │   └─ SUBAGENT_DONE:             → handleSubagentDone()
  │
  └─ 일반 도구 활동
      ├─ 스레드 답장으로 전송
      └─ StreamingMessageUpdater에 추가 (실시간 업데이트)
```

**일반 도구 활동 Slack 메시지 (스레드 답장)**:
```
📖 Read(`src/bridge/hook-server.ts`)
✏️ Edit(`src/main.ts`) +5 lines - "const x = 1"
💻 `npm test`
```

---

### 2.5 구조화 이벤트 (tool.activity의 하위 유형)

#### 2.5.1 Task 체크리스트 (`TASK_CREATE` / `TASK_UPDATE`)

Claude가 TaskCreate/TaskUpdate 도구를 사용하면, hook이 구조화된 JSON prefix를 생성한다.

**Slack 전달**: `handleTaskProgress()`
- 인스턴스별 하나의 체크리스트 메시지를 스레드에 생성
- 새 태스크 추가/상태 변경 시 동일 메시지를 `updateMessage()`로 갱신

**Slack 메시지 예시 (스레드, 계속 업데이트됨)**:
```
📋 작업 목록 (2/5 완료)
✅ #1 데이터베이스 스키마 설계
✅ #2 API 엔드포인트 구현
🔄 #3 테스트 작성 중
⬜ #4 문서화
⬜ #5 코드 리뷰
```

#### 2.5.2 Git 활동 (`GIT_COMMIT` / `GIT_PUSH`)

Bash 도구 응답에서 git commit/push를 감지하면 자동으로 구조화 이벤트를 생성한다.

**Slack 전달**: `handleGitActivity()`
- 스레드 답장으로 전송

**Slack 메시지 예시 (스레드)**:
```
📦 Committed: "fix: capture intermediate text across system-injected messages"
   1 file changed, 15 insertions(+), 3 deletions(-)
```
```
🚀 Pushed to origin/main (ba38e36)
```

#### 2.5.3 서브에이전트 완료 (`SUBAGENT_DONE`)

`discode-subagent-hook.js`에서 발생. Task 도구로 실행된 서브에이전트가 완료되면 호출된다.

**Slack 전달**: `handleSubagentDone()`
- 스레드 답장으로 전송
- 마지막 메시지를 200자로 잘라서 요약

**Slack 메시지 예시 (스레드)**:
```
🔍 Explore 완료: "Found 3 relevant files in src/bridge/ directory..."
```

---

### 2.6 `session.notification` — 알림

**소스**: `discode-notification-hook.js`

Claude가 사용자 알림을 발생시킬 때 (권한 요청, 유휴 프롬프트, 인증 성공 등).

**페이로드**:
```json
{
  "type": "session.notification",
  "notificationType": "permission_prompt",
  "text": "Claude wants to run: npm test",
  "promptText": "AskUserQuestion 포맷팅된 텍스트 (선택)"
}
```

**알림 유형별 이모지**:

| notificationType | 이모지 | 설명 |
|---|---|---|
| `permission_prompt` | 🔐 | 도구 실행 권한 요청 |
| `idle_prompt` | 😴 | 유휴 상태 프롬프트 |
| `auth_success` | 🔑 | 인증 성공 |
| `elicitation_dialog` | ❓ | 사용자 입력 대화 |
| 기타 | 🔔 | 기본 알림 |

**Slack 전달 흐름**:
1. `handleSessionNotification()` 핸들러가 처리
2. 알림 유형에 맞는 이모지 매핑
3. 채널에 알림 메시지 전송
4. `elicitation_dialog`인 경우: `promptText` 전송 **생략** (Stop hook이 버튼으로 전달)
5. 그 외: `promptText`가 있으면 추가로 분할 전송

**Slack 메시지 예시**:
```
🔐 Claude wants to run: npm test
```

---

### 2.7 Thinking 이벤트 (파이프라인 내부 생성)

`thinking.start`와 `thinking.stop`은 hook 스크립트가 아닌 Bridge 내부에서 생성되는 이벤트이다.

#### `thinking.start`
- 시작 메시지가 없으면 생성
- 🧠 리액션을 부모 메시지에 추가
- 10초 간격 타이머로 경과 시간 표시

**스트리밍 메시지 업데이트**:
```
🧠 Thinking... (10s)
🧠 Thinking... (20s)
```

#### `thinking.stop`
- 타이머 정리
- 5초 이상 사고했으면 경과 시간 기록
- 🧠 리액션을 ✅로 교체

**스트리밍 메시지 업데이트**:
```
🧠 Thought for 15s
```

---

## 3. 스트리밍 메시지 업데이트

도구 활동과 thinking 이벤트는 **StreamingMessageUpdater**를 통해 하나의 메시지에 실시간으로 누적된다.

**동작 방식**:
1. 세션 시작 시 부모 메시지 생성
2. 각 이벤트가 `append()` 호출 → 내용 추가
3. 750ms 디바운스로 실제 Slack API `chat.update` 호출 최소화
4. 세션 완료 시 `finalize()`로 최종 헤더 업데이트

**메시지 진행 예시** (하나의 메시지가 계속 업데이트됨):

```
⏳ Processing...
───
📖 Read(`src/main.ts`)
✏️ Edit(`src/main.ts`) +3 lines
🧠 Thinking... (5s)
💻 `npm test`
```

최종 상태:
```
✅ Done · 15,234 tokens · $0.12
───
📖 Read(`src/main.ts`)
✏️ Edit(`src/main.ts`) +3 lines
🧠 Thought for 8s
💻 `npm test`
```

---

## 4. 인터랙티브 메시지

### 4.1 승인 요청 (Approval Request)

도구 실행 권한이 필요할 때 Slack 블록으로 버튼 메시지를 전송한다.

**구조** (Slack Block Kit):
```
Section:
  🔐 *Permission Request*
  Tool: `Bash`
  ```npm install express```
  _120s timeout, auto-deny on timeout_

Actions:
  [Allow (primary)] [Deny (danger)]
```

- 타임아웃 시 자동 거부
- 사용자 클릭 시 즉시 응답

### 4.2 질문 버튼 (Question with Buttons)

Claude의 `AskUserQuestion` 도구가 호출되면, `session.idle` 이벤트의 `promptQuestions` 필드에서
구조화된 질문 데이터를 추출하여 `sendQuestionWithButtons()`로 인터랙티브 버튼을 전송한다.

**전달 흐름**:
1. Stop hook이 트랜스크립트에서 `AskUserQuestion` tool_use 블록의 raw questions 추출
2. `postPromptChoices()` → `sendQuestionWithButtons()` (fire-and-forget)
3. 사용자가 버튼 클릭 → 선택값이 `messageCallback`을 통해 Claude에 자동 전달
4. 중복 방지: `handleSessionNotification()`은 `elicitation_dialog`일 때 `promptText` 전송 생략

**구조** (Slack Block Kit):
```
Section:
  ❓ *Header*
  질문 텍스트

Section (선택):
  *옵션1*: 설명
  *옵션2*: 설명

Actions:
  [옵션0 (primary)] [옵션1] [옵션2]
```

- 5분 타임아웃 (기본값)
- 사용자 클릭 시 선택 확인 메시지로 업데이트 + 선택값을 Claude에 자동 전달
- `promptQuestions`가 없으면 `promptText`를 일반 텍스트로 폴백

---

## 5. Slack 특화 처리

### 5.1 메시지 크기 제한
- **분할 단위**: 3,900자 (Discord는 1,900자)
- 긴 텍스트는 여러 메시지로 자동 분할

### 5.2 이모지 매핑
Unicode 이모지를 Slack 이모지 이름으로 변환:

| Unicode | Slack 이름 |
|---|---|
| ⏳ | `:hourglass_flowing_sand:` |
| ✅ | `:white_check_mark:` |
| ❌ | `:x:` |
| ⚠️ | `:warning:` |
| 🔒 | `:lock:` |
| 🧠 | `:brain:` |

### 5.3 파일 업로드
- `filesUploadV2` API 사용 (스트림 기반)
- 프로젝트 디렉토리 내의 파일만 업로드 허용 (보안)
- 첫 번째 파일에만 `initial_comment` 추가

### 5.4 스레딩
- 세션의 첫 메시지가 스레드 부모
- 도구 활동, thinking, 사용량 통계 → 스레드 답장
- 메인 응답, 파일 → 채널 직접 전송

### 5.5 연결 방식
- **Socket Mode** (WebSocket) — webhook 없이 연결
- **폴링 폴백**: `SLACK_HISTORY_POLL_MS` (기본 5000ms) 간격으로 누락 메시지 확인
- **메시지 중복 제거**: 최근 100개 메시지 타임스탬프 추적

---

## 6. 채널별 큐잉 & 직렬화

모든 이벤트는 채널별 큐(`HookEventPipeline.channelQueues`)에서 직렬 처리된다.

```
Channel A Queue: [event1] → [event2] → [event3] → ...
Channel B Queue: [event4] → [event5] → ...
```

이 설계의 이유:
- Slack 메시지 순서 보장
- 스트리밍 메시지 업데이트 충돌 방지
- 동시 세션의 독립적 처리

---

## 7. 에러 처리

| 계층 | 전략 |
|---|---|
| Hook 스크립트 | `try-catch`로 감싸고 실패 시 무시 (graceful degradation) |
| Bridge Server | 잘못된 JSON → 400, 페이로드 과대 → 413, 내부 오류 → 500 |
| Event Pipeline | 프로젝트/채널 미발견 → 경고 로그 후 false 반환 |
| Slack API | 각 호출을 `try-catch`로 감싸고 실패 시 로그만 남김 |

---

## 8. 전체 시퀀스 다이어그램

```
사용자 메시지 (Slack) → SlackClient → AgentBridge → Claude Code
                                                        │
                                                        ▼
                                              [Claude 작업 수행]
                                                        │
    ┌───────────────────────────────────────────────────┘
    │
    ├─ SessionStart hook    ──→ session.start    ──→ "▶️ Session started"
    │                                                  (스레드 부모 메시지 생성)
    │
    ├─ [thinking 시작]      ──→ thinking.start   ──→ 🧠 리액션 + 타이머
    │
    ├─ [thinking 종료]      ──→ thinking.stop    ──→ ✅ 리액션 교체
    │
    ├─ Tool hook (Read)     ──→ tool.activity    ──→ "📖 Read(`file`)" (스레드)
    ├─ Tool hook (Edit)     ──→ tool.activity    ──→ "✏️ Edit(`file`)" (스레드)
    ├─ Tool hook (Bash)     ──→ tool.activity    ──→ "💻 `cmd`" (스레드)
    │   └─ git commit 감지  ──→ tool.activity    ──→ "📦 Committed: ..." (스레드)
    │
    ├─ Tool hook (TaskCreate) → tool.activity    ──→ 📋 체크리스트 생성/갱신 (스레드)
    │
    ├─ Notification hook    ──→ session.notification → "🔐 Permission..." (채널)
    │
    ├─ Subagent hook        ──→ tool.activity    ──→ "🔍 agent 완료" (스레드)
    │
    └─ Stop hook            ──→ session.idle     ──→ 메인 응답 (채널)
                                                  ──→ 파일 업로드 (채널)
                                                  ──→ 사용량 (스레드)
                                                  ──→ thinking (스레드)
                                                  ──→ 프롬프트/버튼 (채널)
```
