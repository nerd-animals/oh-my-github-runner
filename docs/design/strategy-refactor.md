# Strategy 패턴 리팩터 설계 문서

**상태**: 설계 합의 (구현 미시작)
**작성**: 2026-04-30
**계기**: [#63 issue opened에 대한 report 발행](https://github.com/SanGyuk-Raccoon/oh-my-github-runner/issues/63)
**범위**: 본 이슈 #63은 작은 변경이지만, 토론 과정에서 시스템의 "무엇을 어떻게"를 표현하는 자리(yaml + ExecutionMode + InstructionDefinition) 전체가 어색하다는 게 드러나, 이를 "strategy 함수 + 데이터(md/task)"로 환원하는 큰 리팩터를 본 이슈의 prerequisite으로 도입한다.

---

## 1. 핵심 컨셉

### 1.1 Layer 정정 — Tool ≠ Agent

| Layer | 정체 | 현재 명명 |
|---|---|---|
| 3 (시스템 자신) | 진짜 agent — task 처리 흐름 | (이름 없음) |
| 2 (LLM CLI) | claude / codex / gemini = "프롬프트 in / 텍스트 out" 도구 | `AgentRunner` (잘못된 이름) |
| 1 (OS 프로세스) | `processRunner` | OK |

`task.agent` 필드는 의미상 `tool` 또는 `toolName`이 정확하지만 당장 rename은 별 작업.

### 1.2 Strategy 패턴 — `instructionId` 키

```ts
type Strategy = {
  policies: {
    supersedeOnSameSource: boolean;   // EnqueueService가 읽어서 처리
    timeoutMs: number;                 // per-strategy (yaml.execution.timeout_sec 대체)
  };
  run: (task: Task, tk: Toolkit, signal: AbortSignal) => Promise<ExecuteResult>;
};

// instructionId 자체가 source kind를 함의 (dispatcher가 (eventKind, verb)→id로 라우팅)
// → strategy 메타에 sourceKind 따로 둘 필요 없음. enqueue 검증도 불필요.

const strategies = new Map<string, Strategy>([
  ["issue-initial-review", issueInitialReviewStrategy],
  ["issue-comment-reply",  issueCommentReplyStrategy],
  ["pr-review-comment",    prReviewCommentStrategy],
  ["issue-implement",      issueImplementStrategy],
  ["pr-implement",         prImplementStrategy],
]);
```

- "무엇을 어떻게"는 strategy 함수 한 곳에서 결정
- workflow enum / mode enum 분기 모두 strategy 안의 toolkit 호출로 흡수
- yaml 깃발로 표현 못하던 다중 단계·다중 tool 파이프라인이 자연스럽게 표현됨
- supersede 정책도 strategy 메타에 같이 표시 — `EnqueueService`가 enqueue 시점에 참고

### 1.3 Toolkit — 원시 동작 면(面)

```ts
interface Toolkit {
  ai: { run(opts: AiRunOptions): Promise<AiRunResult> };
  github: {
    fetchContext(task: Task): Promise<GitHubContext>;
    getDefaultBranch(repo: RepoRef): Promise<string>;
    postIssueComment(body: string): Promise<void>;
    postPrComment(body: string): Promise<void>;
    // mutate 강용: commit, push, createPR 등
  };
  workspace: {
    prepareObserve(task: Task, ref?: string): Promise<DisposableWorkspace>;
    prepareMutate(task: Task, opts?: { baseBranch?: string }): Promise<DisposableMutateWorkspace>;
    preparePrImplement(task: Task, headRef: string): Promise<DisposableMutateWorkspace>;
  };
  naming: {
    buildBranchName(task: Task): string;   // ai/<source-kind>-<number>-<short-taskId>
  };
}

interface AiRunOptions {
  agent: "claude" | "codex" | "gemini";    // 이름은 그대로 (rename은 별 작업)
  prompt: PromptFragment[];                 // 조립 재료 리스트
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs?: number;
  output?: { kind: "stdout" } | { kind: "file"; path: string };
}

type PromptFragment =
  | { kind: "file"; path: string }       // "common/work-rules", "personas/architecture", ...
  | { kind: "literal"; text: string }
  | { kind: "context"; key: ContextKey } // issue-body, comments, diff, linked-refs
  | { kind: "user"; text: string };
```

핵심:
- **prompt가 string이 아니라 fragment 리스트** — md 재사용성 + 명시적 조립 순서
- **권한이 per-call** — 같은 strategy 안에서도 단계마다 다르게 줄 수 있음
- **md 파일은 fragment path 참조로 캐시 재사용** (시작 시 1회 로드)

### 1.4 RAII로 자원 lifetime 보장

```ts
const issueImplementStrategy: Strategy = {
  policies: { supersedeOnSameSource: true },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareMutate(task);
    // ... 작업 ...
    return ok();
    // 함수 빠져나가는 어떤 경로에서도 ws[Symbol.asyncDispose]() 자동 호출
  },
};
```

- `Symbol.asyncDispose`가 workspace 디렉토리 + agent artifact 캐시 정리
- strategy 본체에 try/finally 없음 — 자원 정리 코드 0줄
- **프로세스 크래시 잔여 누수**는 startup janitor (`var/workspaces/` 스캔하여 큐에 없는 taskId 디렉토리 rm)로 보강
- Sticky comment / reaction은 RAII 안 맞음 — daemon notify 훅 유지

### 1.5 Branch 이름에 taskId 포함 → mutate-lock 제거

- `task-naming.ts`의 `buildBranchName`을 `ai/<source-kind>-<number>-<short-taskId>`로 변경
- branch 충돌 race 사라짐 → scheduler의 same-repo-mutate 직렬화 규칙 **완전 제거**
- scheduler는 슬롯 + paused agent 두 가지만 보는 dumb queue가 됨
- 잔여 race는 "같은 source에 PR 2개"라는 UX 문제로만 남음 → supersede로 처리

### 1.6 Supersede on enqueue

- 현재 같은 source 중복 트리거가 통과됨 (`delivery-dedup`은 webhook 재전송만 막음)
- 새 task enqueue 시점에 같은 (repo, source) active task를 종결시키고 자기가 우선
- 정책 lookup은 **lookup-on-demand** (denormalize 안 함) — enqueue 1회만 참조하므로
- queued → 마크만, running → AbortController로 자식 프로세스 중단 + RAII 자동 정리
- Sticky 갱신: "이 요청은 #<newTaskId>로 대체되어 중단되었습니다"
- 키 = `(repo, source)` — 같은 source의 review 도중 implement 들어오면 review 취소 (단순/일관)

### 1.7 yaml과 InstructionDefinition 폐기

폐지:
- `definitions/instructions/*.yaml`
- `src/infra/instructions/instruction-loader.ts`
- `src/domain/instruction.ts` (`InstructionDefinition`, `InstructionContext`, `InstructionPermissions`, `ExecutionMode`, `InstructionWorkflow` 등)

유지:
- `definitions/prompts/_common/work-rules.md`
- `definitions/prompts/personas/*.md`
- `definitions/prompts/modes/*.md` (fragment 자료로 재포지션)
- `definitions/prompts/templates/*.md.tmpl` (특히 `report.md.tmpl` — 다중 페르소나용 반복 섹션 추가)

신규:
- `definitions/prompts/modes/collect-only.md` — "stdout으로만 마크다운, gh 댓글 금지"

---

## 2. 데이터 흐름

```
github webhook
   ↓
event-dispatcher
   - allowlist 가드 (issue_opened은 예외 — bot 허용)
   - (eventKind, verb) → instructionId
   ↓
EnqueueService
   - strategy = strategies.get(instructionId)
   - newTask = queueStore.enqueue(input)            // 새 task 먼저 진입
   - if strategy.policies.supersedeOnSameSource:
       conflicting = queueStore.findActiveBySource(repo, source)
       for each old in conflicting:
         oldStrategy = strategies.get(old.instructionId)
         if oldStrategy.policies.supersedeOnSameSource:
           supersede(old, newTask)                  // queued: 마크 / running: abort
   ↓
RunnerDaemon.tick (fire-and-forget, 매 pollIntervalMs):
   - dispatcher.next() → Task 1개 (슬롯 + paused 본 후)
   - strategy = strategies.get(task.instructionId)
   - signal = new AbortController()
   - activeTasks.set(taskId, { promise, abort })
   - strategy.run(task, toolkit, signal.signal) 백그라운드 실행
   ↓
Strategy 함수:
   - signal.throwIfAborted()
   - await using ws = tk.workspace.prepareXxx(task)
   - ctx = await tk.github.fetchContext(task)
   - tk.ai.run({ ... }) [N회 가능]
   - tk.github.postIssueComment(...)
   - return { status: "succeeded" } | { status: "failed", ... }
   ↓
RunnerDaemon.runTask 후처리:
   - notifyTaskSucceeded / Failed / Superseded
   - queueStore.completeTask
```

---

## 3. PR 작업 단위 (의존 순서)

| # | 작업 | 외부 동작 변화 |
|---|---|---|
| **A** | Strategy 스캐폴딩 + Toolkit 인터페이스 + 5개 default strategy로 이전 (yaml/InstructionDefinition 폐기) + `instructionRevision` 완전 제거 + per-strategy `timeoutMs` 내장 | **0** — 행동 동일 |
| **B** | Branch naming에 taskId 포함 + scheduler에서 mutate-lock 분기 제거 | 큐잉 동작 미세 변화 (같은 repo 동시 mutate 허용) |
| **C** | Supersede on enqueue (running 포함) + AbortController + ChildProcessRunner abort 처리 + RAII workspace + startup orphan janitor | 중복 트리거 시 옛 task 취소 |
| **D** | issueInitialReviewStrategy 다중 페르소나 + collect-only tool preset + collect-only.md + report.md.tmpl 페르소나 반복 섹션 | **본 이슈 #63 본 목표** |
| **E** | event-dispatcher.ts 가드를 `event.kind !== "issue_opened"` 한정 (bot 허용) | issue_opened bot 트리거 통과 |
| **F** | `agent` → `tool` rename (TaskRecord, AgentRunner→ToolRunner, env vars 등) | 외부 명칭만 정정, 행동 동일 |
| **G** | Dispatcher 객체 분리 (queueStore + rateLimitStore + 정책 lookup 묶기) | 행동 동일 |

**A, B, C는 D의 prerequisite.** E는 독립. F·G는 D 이후 별 PR 권장 (대규모 rename/리팩터라 D 검증 후가 안전). task total budget은 보류.

---

## 4. 구체 구현 메모

### 4.1 ChildProcessRunner abort 처리

현재 timeout만 처리. AbortSignal 받아서 `child.kill('SIGTERM')` → 일정 grace period 후 `SIGKILL`.

### 4.2 daemon `activeTasks` 확장

```ts
private readonly activeTasks = new Map<string, {
  promise: Promise<void>;
  abort: AbortController;
}>();
```

### 4.3 QueueStore 메서드 추가

```ts
interface QueueStore {
  // ... 기존
  findActiveBySource(repo: RepoRef, source: SourceRef): Promise<TaskRecord[]>;
  markSuperseded(taskId: string, supersededBy: string): Promise<TaskRecord>;
}
```

`status: "superseded"`를 TaskStatus에 추가. 디렉토리 구조에 `superseded/` 추가 (`var/queue/superseded/<taskId>.json`).

### 4.4 Workspace handle을 Disposable로

```ts
interface DisposableWorkspace {
  readonly path: string;
  [Symbol.asyncDispose](): Promise<void>;
}

interface DisposableMutateWorkspace extends DisposableWorkspace {
  readonly branchName: string;
}
```

`GitWorkspaceManager`가 `cleanupWorkspaceDir + cleanupAgentArtifacts`를 dispose에 묶음. TS 5.2+, Node 22+ 가정.

### 4.5 Startup orphan janitor

```ts
async initialize() {
  await this.queueStore.recoverRunningTasks(...);
  await this.workspaceManager.cleanupOrphanWorkspaces(activeTaskIds);
  await this.logStore.cleanupExpired();
  await this.maybePrune(true);
}
```

`var/workspaces/` 디렉토리 스캔하여 현재 큐(superseded 포함 모든 active 상태)에 없는 taskId 디렉토리 rm.

### 4.6 ToolPreset 상수

```ts
// src/strategies/_shared/tool-presets.ts
export const OBSERVE_ALLOWED = [
  "Read", "Grep", "Glob",
  "Bash(gh:*)",
  "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)",
];
export const OBSERVE_DISALLOWED = [
  "Edit", "Write", "MultiEdit", "NotebookEdit",
  "Bash(git push:*)", "Bash(git commit:*)", "Bash(git add:*)",
  "Bash(rm:*)", "Bash(mv:*)",
];

export const COLLECT_ONLY_ALLOWED = [
  "Read", "Grep", "Glob",
  "Bash(gh issue view:*)", "Bash(gh pr view:*)", "Bash(gh api:*)",
  "Bash(git log:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)",
];
export const COLLECT_ONLY_DISALLOWED = [
  ...OBSERVE_DISALLOWED,
  "Bash(gh issue comment:*)", "Bash(gh pr comment:*)",
  "Bash(gh issue create:*)", "Bash(gh pr create:*)",
  "Bash(gh issue edit:*)", "Bash(gh pr edit:*)",
];

export const MUTATE_ALLOWED = [
  "Read", "Grep", "Glob", "Edit", "Write", "MultiEdit",
  "Bash(gh:*)", "Bash(git:*)", "Bash(npm:*)", "Bash(node:*)",
];
export const MUTATE_DISALLOWED = [
  "Bash(gh pr merge:*)",
];
```

### 4.7 Strategy 예시 — issueInitialReviewStrategy

```ts
const issueInitialReviewStrategy: Strategy = {
  policies: { supersedeOnSameSource: true },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    const ctx = await tk.github.fetchContext(task);

    const personas = ["architecture", "implementation", "infra", "product", "testing"];
    const sections: { persona: string; body: string }[] = [];

    for (const persona of personas) {
      signal.throwIfAborted();
      const r = await tk.ai.run({
        agent: "claude",
        prompt: [
          { kind: "file", path: "_common/work-rules" },
          { kind: "file", path: `personas/${persona}` },
          { kind: "file", path: "modes/collect-only" },
          { kind: "literal", text: header(task, ctx) },
          { kind: "context", key: "issue-body" },
          { kind: "context", key: "linked-refs" },
        ],
        allowedTools: COLLECT_ONLY_ALLOWED,
        disallowedTools: COLLECT_ONLY_DISALLOWED,
      });
      if (r.kind !== "succeeded") return failed(r);
      sections.push({ persona, body: r.stdout });
    }

    await tk.github.postIssueComment(renderReport(task, sections));
    return ok();
  },
};
```

### 4.8 Strategy 예시 — issueCommentReplyStrategy (단일 페르소나 observe)

```ts
const issueCommentReplyStrategy: Strategy = {
  policies: { supersedeOnSameSource: true },
  run: async (task, tk, signal) => {
    signal.throwIfAborted();
    await using ws = await tk.workspace.prepareObserve(task);
    const ctx = await tk.github.fetchContext(task);

    const r = await tk.ai.run({
      agent: task.agent,
      prompt: [
        { kind: "file", path: "_common/work-rules" },
        { kind: "file", path: "personas/architecture" },
        { kind: "file", path: "modes/observe" },
        { kind: "literal", text: header(task, ctx) },
        { kind: "context", key: "issue-body" },
        { kind: "context", key: "comments" },
        { kind: "user", text: task.additionalInstructions ?? "" },
      ],
      allowedTools: OBSERVE_ALLOWED,
      disallowedTools: OBSERVE_DISALLOWED,
    });
    return r.kind === "succeeded" ? ok() : failed(r);
    // observe.md "communication is your job" — agent가 스스로 댓글
  },
};
```

---

## 5. 트랩 / 미묘한 것

1. **Strategy 안에서 `await using`이 핵심**. try/finally를 쓰지 말 것 — RAII가 자원 보장의 단일 패턴이어야 일관됨.
2. **Branch naming 변경(B)이 supersede(C)보다 먼저** — 그 순서가 아니면 mutate-lock 제거 시 race 노출 윈도우 발생.
3. **AbortSignal 전파가 strategy 시그니처의 일부**. 구현 빠뜨리면 supersede가 running task를 못 끊음.
4. **PromptFragment file path는 `definitions/prompts/` 기준**으로 캐시 로드 — 시작 시 1회 로드 후 메모리 재사용.
5. **collect-only는 strategy 안에서 `disallowedTools`로 명시** — prompt 텍스트에 "댓글 달지 마"는 enforcement 부족. tool 차단이 본질.
6. **observe.md vs collect-only.md 분리** — observe.md의 "communication is your job"은 collect-only에선 정반대.
7. **`runner-daemon.ts:97-100`의 `instruction.revision`** — Strategy 모델에서 revision 개념이 어색해짐. 감사용 metadata로만 남기거나 제거.
8. **enqueue 후 supersede 순서가 중요** — 새 task 먼저 큐 진입, 그 다음 옛 task 정리. 역순이면 중간에 큐가 비는 race.
9. **`definitions/prompts/_common/work-rules.md`, `personas/*.md`** 그대로 활용. **`modes/*.md`**는 fragment로 재포지션.
10. **`TaskRecord.agent` 필드 의미는 "tool 이름"** — strategy가 `task.agent`를 `ai.run({agent: ...})`에 전달.

---

## 6. 미결정 / 연기 (2026-04-30 갱신)

- **R3 봇 폭주 안전망** (`ALLOWED_BOT_FOR_ISSUE_OPENED` 등) — skip. 운영 관찰 후 별 이슈.
- **Tool/Agent 이름 정정** (rename `agent` → `tool`) — **PR F로 진행**.
- **Dispatcher 객체 분리** (queueStore + rateLimitStore + 정책 lookup 묶기) — **PR G로 진행**.
- **Phase 1~3 mode enum 제거 풀 리팩터** — Strategy 패턴이 흡수, 별도 작업 안 함.
- **observe도 supersede할까** — strategy.policies.supersedeOnSameSource로 표시, EnqueueService가 enqueue 시 참고. PR C에선 5개 모두 `true`로 시작, 운영 후 strategy 메타만 끄면 됨.
- **task total timeout budget** — 보류.
- **per-strategy timeoutMs 디폴트** — strategy.policies.timeoutMs로 내장 (PR A에 흡수). 현재 yaml `timeout_sec: 1800`을 그대로 옮김.
- **`task.instructionRevision`** — 완전 제거 (PR A에 흡수). 감사 metadata 유지 안 함.

---

## 7. 한 단락 요약

이 시스템은 "yaml + mode enum + workflow + instruction-loader"로 행동을 표현하던 OOP-heavy 모델을 **"id 키로 등록된 strategy 함수 + RAII + 평탄 task 데이터"로 환원**한다. agent라는 단어는 시스템 자신에 돌려주고, claude/codex/gemini는 Layer 2 도구로 격하. branch에 taskId를 박아 same-repo-mutate race를 없애고, 같은 source 중복 트리거는 enqueue 시점 supersede로 처리. workspace lifetime은 `await using`으로 보장. yaml/InstructionDefinition은 폐기, 메타는 strategy의 작은 정책 객체로 흡수. 결과적으로 "이 instructionId가 무엇을 어떻게 하는지"가 strategy 파일 한 곳에서 끝나는 단일 source of truth가 된다.
