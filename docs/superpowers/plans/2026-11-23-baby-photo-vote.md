# 아기 사진 주차별 부부 투표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주차별 후보 사진을 올리고 부부가 각자 휴대폰으로 토너먼트 투표해 겹친 1~3장을 PC `selected/`에 원본으로 저장하는 웹앱.

**Architecture:** PC의 의존성 없는 Node 서버(`127.0.0.1:8790`)를 Tailscale serve/funnel(10000 포트)로 노출한다. 사진 분석(흐림·중복·얼굴)은 휴대폰 브라우저에서 한다. 대진·결과 로직은 DOM 없는 순수 모듈로 두고 서버와 화면이 같이 쓴다.

**Tech Stack:** Node v24(`node:http`, `node:test`), 바닐라 ES modules, `@mediapipe/tasks-vision`(로컬 vendor), exifr(로컬 vendor), Tailscale 1.104.6.

**Spec:** `docs/superpowers/specs/2026-11-23-baby-photo-picker-design.md`

## Global Constraints

- 서버는 `127.0.0.1:8790`에만 바인딩한다. 포트 8787은 다른 프로그램이 쓴다.
- Tailscale은 10000 포트만 쓴다. 443(→18951)과 8443(→8787) serve 설정은 절대 바꾸지 않는다. `tailscale serve reset`은 금지한다.
- 런타임 npm 의존성은 0개다. 브라우저 라이브러리는 `public/vendor/`에 버전을 고정해 두고, CDN은 쓰지 않는다.
- 원본 사진은 받은 바이트 그대로 저장하고 복사한다. 재인코딩과 리사이즈는 금지한다.
- 주차 ID는 `^\d{4}-W\d{2}$` 형식이다(ISO 8601 주차).
- 최종 파일명은 `selected/<주차>_<순위>.<ext>`다. 예: `selected/2026-W47_1.jpg`
- `pool/`, `data/`, `selected/`, `config.json`, `node_modules/`는 gitignore 대상이다.
- Funnel 요청(`Tailscale-Funnel-Request: ?1`)은 투표 경로만 허용한다. 관리 경로는 Funnel이 아니고 `Tailscale-User-Login`이 `config.json`의 `adminLogin`과 같을 때만 허용한다. 거부 응답은 모두 404다.
- 화면 문구는 한국어이고, 휴대폰 세로 화면을 기준으로 한다.
- 파일 담당: `public/analyze.js`와 `public/vendor/mediapipe/**`는 Codex(wE:p3), 나머지는 Claude(wE:p1)가 맡는다.

## Review Focus

1. 둘이 거의 동시에 탭하는 경우와, 같은 탭을 두 번 보내는 경우(느린 망에서 재전송): 투표가 한 번만 반영되고 상태가 깨지지 않아야 한다. → Task 4 `concurrent picks` 테스트
2. 후보가 1장, 2장, 3장, 또는 2의 거듭제곱이 아닌 수(예: 5, 13)인 경우: 부전승이 생겨도 대진이 끝나고, 순위는 있는 만큼만 나와야 한다. → Task 3 `odd sizes` 테스트
3. 두 사람의 3위 안 사진이 하나도 겹치지 않는 경우: 함께 결승이 나오고, 결승이 끝나면 정확히 1장이 저장돼야 한다. → Task 3 `no overlap` 테스트, Task 4 `joint final` 테스트
4. 지난주 토큰이나 위조한 Funnel 헤더로 접속하는 경우: 404가 나와야 하고 사진이 보이면 안 된다. → Task 5 `access control` 테스트
5. 최종 복사 도중 서버가 재시작되는 경우: 같은 파일명으로 이어서 복사하고 `done`이 돼야 한다. 중복 파일이 생기면 안 된다. → Task 4 `finalize resume` 테스트

---

### Task 1: 프로젝트 뼈대 + Funnel 스크립트 + 접근 검증 스파이크

**Files:**
- Create: `.gitignore`, `package.json`, `config.example.json`, `README.md`
- Create: `scripts/funnel.js`
- Create: `spike/headers-server.js` (스파이크용, Task 5 이후 삭제)

**Interfaces:**
- Produces: `npm run funnel:on|funnel:off|funnel:status`. `config.json`: `{ "adminLogin": "<tailscale login>", "port": 8790 }`

- [ ] **Step 1:** `git init -b main`을 실행한다. 로컬 저장소만 만들고 원격 저장소는 만들지 않는다. `.gitignore`(Global Constraints 목록), `package.json`(`"type":"module"`, scripts: `start`, `test: node --test`, `funnel:on`, `funnel:off`, `funnel:status`), `config.example.json`을 만든다.
- [ ] **Step 2:** `scripts/funnel.js <on|off|status>`를 구현한다.
  - `on`: `tailscale funnel --bg --https=10000 http://127.0.0.1:8790`
  - `off`: `tailscale funnel --https=10000 off` 후 `tailscale serve --bg --https=10000 http://127.0.0.1:8790`
  - 실행 전과 후에 `tailscale serve status --json`을 읽는다. 10000이 아닌 포트의 설정이 달라졌으면 크게 경고하고 exit 1로 끝낸다.
  - 마지막에 10000 포트의 실제 상태(`funnel`/`tailnet`/`off`)를 출력한다.
  - (토큰 폐기는 Task 8에서 붙인다.)
- [ ] **Step 3:** `spike/headers-server.js`를 만든다. `127.0.0.1:8790`에서 받은 요청 헤더를 JSON으로 그대로 돌려준다.
- [ ] **Step 4: 검증 (사용자와 함께)**
  1. `npm run funnel:off` 실행: 10000 포트가 tailnet, 443·8443이 그대로여야 한다.
  2. 갤럭시(tailnet)에서 `https://my-pc.example-tailnet.ts.net:10000` 접속: `Tailscale-User-Login`이 보이고 `Tailscale-Funnel-Request`는 없어야 한다. 이 login 값을 `config.json`의 `adminLogin`에 기록한다.
  3. `npm run funnel:on` 후 휴대폰 데이터망(Wi-Fi·Tailscale 끔)으로 접속: `Tailscale-Funnel-Request: ?1`이 보여야 한다. `curl -H "Tailscale-Funnel-Request: x" -H "Tailscale-User-Login: x"`로 위조해도 서버에는 위조 값이 도달하지 않아야 한다.
  4. `npm run funnel:off` 후 외부 접속이 실패해야 하고, 443·8443이 그대로여야 한다.
  - Funnel이 tailnet 정책에서 막혀 있으면 멈춘다. 사용자에게 관리 콘솔에서 켜는 방법을 안내한다.
- [ ] **Step 5:** 커밋 `chore: scaffold project and funnel toggle script`

### Task 2 (Codex): MediaPipe vendor + `analyze.js` + 갤럭시 스파이크

**Files:**
- Create: `public/vendor/mediapipe/**` (tasks-vision 고정 버전 번들, wasm 로더·바이너리, `face_landmarker.task`)
- Create: `public/analyze.js`
- Create: `public/analyze-spike.html` (스파이크용)
- Test: `test/analyze.pure.test.js` (DOM 없는 부분: dHash 해밍, Laplacian 분산, 점수 정규화)

**Interfaces:**
- Produces (스펙 그대로):
  ```js
  export async function preloadModels(): Promise<void>
  export async function analyzeDay(files: File[], { onProgress }?: { onProgress?: ({done,total}) => void })
    : Promise<{ kept: {file, score, reasons: string[]}[],
                excluded: {file, score: number|null, reason: 'blur'|'duplicate'|'unsupported', duplicateOf?: File}[],
                warnings: string[] }>
  ```
  순수 헬퍼는 같은 파일에서 named export로 내보낸다: `hamming(a: bigint, b: bigint): number`, `laplacianVariance(gray: Uint8ClampedArray, w: number, h: number): number`, `combineScore(parts: {sharp, exposure, eyes?, smile?}): number`.

- [ ] **Step 1:** 순수 헬퍼 테스트를 작성한다.
  - `hamming(0n, 0b1011n) === 3`
  - 단색 이미지의 `laplacianVariance === 0`, 체커보드 이미지는 0보다 크다.
  - 얼굴 항목이 없는 `combineScore`는 같은 sharp·exposure에 얼굴 항목이 만점인 경우와 비교해 비율상 불이익이 없다(재정규화).
  - 얼굴 가중치 합은 전체 가중치의 30% 이하다.
- [ ] **Step 2:** 테스트가 실패하는지 확인한다(`node --test test/analyze.pure.test.js`).
- [ ] **Step 3:** `analyze.js`를 구현한다. 스펙의 분석 모듈 절을 따른다: `numFaces: 5`, 512px 축소, 사진 사이마다 프레임 양보, 상대 기준 흐림, `duplicateOf`는 kept 대표, 모델 실패 시 `warnings`.
- [ ] **Step 4:** 테스트가 통과하는지 확인한다.
- [ ] **Step 5: 갤럭시 스파이크.** `analyze-spike.html`은 파일 선택 → `analyzeDay` → 결과 JSON을 화면에 출력한다. Claude가 Task 5 서버로 제공하고, 사용자가 갤럭시에서 실행한다.
  - 기대 결과: 얼굴 사진 1장 이상에서 `reasons`에 eyes/smile 값이 나온다. `warnings`가 비어 있다. 50장이 10초 이내에 끝난다(모델 로드 시간 제외).
  - 실패하면 멈추고 사용자와 상의한다.
- [ ] **Step 6:** 커밋 `feat: add on-device photo analysis`

### Task 3: 대진·순위·결과 합치기 + 주차 계산 (순수 모듈)

**Files:**
- Create: `public/bracket.js`, `public/week.js`
- Test: `test/bracket.test.js`, `test/week.test.js`

**Interfaces:**
- Produces:
  ```js
  // week.js
  export function isoWeek(date: Date): string            // '2026-W47'
  // bracket.js
  export function createBracket(ids: string[], rng: () => number): Bracket
  export function currentMatch(b: Bracket): { id: string, a: string, b: string, label: string, index: number, total: number } | null
  export function applyPick(b: Bracket, matchId: string, winnerId: string): Bracket   // 잘못된 matchId/winnerId면 throw MatchError
  export function undo(b: Bracket): Bracket            // 되돌릴 것 없으면 그대로
  export function ranks(b: Bracket): string[]           // 완료 시 [1위, 2위, 3위] (후보 수만큼, 최대 3)
  export function merge(ranksA: string[], ranksB: string[], scores: Record<string, number>)
    : { saved: string[] } | { jointFinal: [string, string] }
  export class MatchError extends Error {}
  ```
  `Bracket`은 JSON 직렬화 가능한 평범한 객체다(서버 저장용). `label` 예: `"8강"`, `"준결승"`, `"3·4위전"`, `"결승"`.
  3·4위전은 결승 전에 진행한다.

- [ ] **Step 1:** 테스트를 작성한다.
  - `isoWeek(new Date('2026-11-23T10:00')) === '2026-W48'`, `isoWeek(new Date('2027-01-01')) === '2026-W53'`, `isoWeek(new Date('2024-12-30')) === '2025-W01'`
  - **odd sizes**: n ∈ {1,2,3,4,5,8,13,16}마다 첫 번째 후보만 계속 고르는 방식으로 끝까지 진행한다. `currentMatch`가 `null`이 되고, `ranks.length === Math.min(n,3)`이며, 순위 id는 중복이 없다. n=1이면 경기 0번에 `ranks === [id]`다.
  - 같은 `rng`면 대진이 같고, 다른 `rng`면 순서가 다르다.
  - `applyPick` 후 `undo`를 하면 이전 `currentMatch`와 같다. 이미 끝난 경기 id로 `applyPick`하면 `MatchError`가 난다.
  - `merge(['a','b','c'], ['c','a','x'], s)`의 `saved`는 `['a','c']`다. 순위 합이 a=1+2=3, c=3+1=4이기 때문이다. 순위 합이 같으면 `scores`가 높은 쪽이 앞이다.
  - **no overlap**: `merge(['a','b','c'], ['x','y','z'], s)`는 `{ jointFinal: ['a','x'] }`다.
  - 각자 1위가 같으면 그 사진이 `saved[0]`이다.
- [ ] **Step 2:** 테스트가 실패하는지 확인한다(`node --test test/bracket.test.js test/week.test.js`).
- [ ] **Step 3:** `bracket.js`와 `week.js`를 구현한다. 부전승은 1회전에서 상위 슬롯에 자동 진출로 처리하고, 경기로 세지 않는다.
- [ ] **Step 4:** 테스트가 통과하는지 확인한다.
- [ ] **Step 5:** 커밋 `feat: add bracket, ranking and merge logic`

### Task 4: 주차 저장소 (잠금·원자적 쓰기·확정 복구)

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js` (임시 디렉터리 사용)

**Interfaces:**
- Consumes: Task 3 `createBracket`, `applyPick`, `undo`, `ranks`, `merge`, `MatchError`
- Produces:
  ```js
  export function createStore(rootDir: string): Store
  // Store 메서드 (모두 async, 주차별 직렬화)
  listWeeks(): WeekSummary[]                         // {week, status, photoCount, voters:{me:{done},wife:{done}}}
  addPhoto(week, { bytes: Buffer, ext, originalName, takenAt, score, thumb: Buffer }): { id }
  removePhoto(week, id): void                         // collecting 상태에서만
  setScores(week, Record<id, number>): void
  startVoting(week): { me: token, wife: token }       // collecting → voting, 사진 0장이면 throw
  findByToken(token): { week, voter: 'me'|'wife' } | null   // voting/finalizing/done이고 폐기 전인 것만
  voterState(week, voter): VoterView                  // {status, match, myRanks, otherDone, result}
  pick(week, voter, matchId, winnerId): VoterView     // MatchError → 최신 상태와 함께 409
  undo(week, voter, matchId): VoterView
  jointPick(week, winnerId): VoterView                // 첫 유효 요청만 반영
  resumeFinalize(): void                              // 기동 시 finalizing 주차 이어서 복사
  revokeDoneTokens(): number
  photoPath(week, id, kind: 'orig'|'thumb'): string
  ```
  디스크 구조는 스펙의 데이터 절을 따른다. 상태 흐름은 `collecting → voting → (jointFinal 대기) → finalizing → done`이다.
  토큰은 `crypto.randomBytes(24).toString('base64url')`로 만든다.

- [ ] **Step 1:** 테스트를 작성한다.
  - `addPhoto` 후 원본 파일 바이트가 입력과 같다(`Buffer.equals`).
  - `startVoting` 이후에는 `addPhoto`가 throw한다.
  - **concurrent picks**: 같은 `pick(week,'me',m,w)`를 `Promise.all`로 2번 보내면 1번은 성공하고 1번은 `MatchError`다. me와 wife를 동시에 20판 진행해도 둘 다 끝까지 간다.
  - 둘 다 끝나고 겹친 사진이 있으면 `selected/2026-W47_1.jpg`…가 생기고 상태는 `done`이다. 상대가 끝나기 전에는 `voterState(...).result`가 `null`이고, 상대의 순위를 담은 필드도 없다.
  - **joint final**: 겹친 사진이 없으면 상태가 jointFinal 대기다. `jointPick`을 동시에 2번 보내면 먼저 처리된 1번만 반영되고, `selected/`에 정확히 1장이 생긴다.
  - **finalize resume**: `finalizing` 상태 JSON과 일부만 복사된 `selected/`를 준비한다. 새 store에서 `resumeFinalize()`를 실행하면 나머지가 복사되고 `done`이 된다. 기존 파일은 덮어쓰지 않으며 같은 이름 그대로다.
  - `revokeDoneTokens()` 후 `findByToken`이 `null`을 반환한다.
- [ ] **Step 2:** 테스트가 실패하는지 확인한다(`node --test test/store.test.js`).
- [ ] **Step 3:** `src/store.js`를 구현한다. 주차별 Promise 체인 잠금을 쓰고, JSON은 `.tmp`에 쓴 뒤 rename한다.
- [ ] **Step 4:** 테스트가 통과하는지 확인한다.
- [ ] **Step 5:** 커밋 `feat: add week store with locking and finalize recovery`

### Task 5: HTTP 서버 + 접근 제어

**Files:**
- Create: `server.js`, `src/routes.js`
- Delete: `spike/`
- Test: `test/server.test.js` (임시 루트, 임의 포트)

**Interfaces:**
- Consumes: Task 4 `Store`
- Produces (HTTP):
  - 관리(tailnet + `adminLogin`):
    - `GET /admin`
    - `GET /api/admin/weeks`
    - `GET /api/admin/weeks/:week/photos` → `[{id, originalName, takenAt, score}]`
    - `GET /api/admin/img/:week/:id` (썸네일)
    - `POST /api/admin/weeks/:week/photos?ext=&name=&takenAt=&score=`: body는 원본 바이트, 헤더 `X-Thumb-Length`, body 앞쪽이 썸네일이고 뒤쪽이 원본이다 → `{id}`
    - `DELETE /api/admin/weeks/:week/photos/:id`
    - `PUT /api/admin/weeks/:week/scores`
    - `POST /api/admin/weeks/:week/start` → `{links:{me,wife}}` (절대 URL, `https://my-pc.example-tailnet.ts.net:10000/v/<token>`)
    - `GET /api/admin/funnel` → `{state}`
    - `GET /analyze-spike.html`
  - 투표(토큰): `GET /v/:token`(vote.html), `GET /v/:token/api/state`, `POST /v/:token/api/pick {matchId,winnerId}`, `POST /v/:token/api/undo {matchId}`, `POST /v/:token/api/joint {winnerId}`, `GET /v/:token/img/:id`
  - 정적 파일 중 Funnel 허용: `/vote.js`, `/vote.css`, `/bracket.js`, `/styles.css`. 나머지 `public/`는 관리 전용이다.
  - MIME: `.js`/`.mjs` → `text/javascript`, `.wasm` → `application/wasm`, `.task` → `application/octet-stream`

- [ ] **Step 1:** 테스트를 작성한다.
  - **access control**:
    - `Tailscale-Funnel-Request: ?1`이 붙은 `GET /admin`, `/api/admin/weeks`, `/vendor/mediapipe/...`는 404다.
    - `Tailscale-User-Login`이 없거나 다른 계정이면 `/admin`은 404다. 맞는 계정이면 200이다.
    - 폐기된 토큰과 없는 토큰의 `/v/<t>/api/state`는 404다.
    - `/v/<t>/img/../../config.json` 같은 경로 조작은 404다. 형식에 맞지 않는 주차 `../x`도 404다.
  - Funnel 요청이어도 `/v/<유효 토큰>/api/state`는 200이다.
  - `POST pick`에 오래된 `matchId`를 보내면 409와 최신 상태가 온다.
  - `.wasm` 응답의 `Content-Type`은 `application/wasm`이다.
  - 업로드 후 `GET /api/admin/weeks/:week/photos` 길이가 1이다.
- [ ] **Step 2:** 테스트가 실패하는지 확인한다(`node --test test/server.test.js`).
- [ ] **Step 3:** `server.js`(config 로드, `127.0.0.1` 바인딩, 기동 시 `resumeFinalize`)와 `src/routes.js`를 구현한다. 업로드 크기 상한은 장당 50MB다.
- [ ] **Step 4:** 테스트가 통과하는지 확인한다. 이어서 `npm test` 전체를 실행한다.
- [ ] **Step 5:** 커밋 `feat: add http server with funnel-aware access control`

### Task 6: 관리 화면 (후보 올리기·투표 시작)

**Files:**
- Create: `public/admin.html`, `public/admin.js`, `public/styles.css`
- Create: `public/vendor/exifr/` (exifr lite 고정 버전 단일 파일)

**Interfaces:**
- Consumes: Task 2 `preloadModels`, `analyzeDay`; Task 3 `isoWeek`; Task 5 관리 API

- [ ] **Step 1:** 화면 흐름을 구현한다.
  1. 주차 목록과 상태를 보여준다.
  2. "사진 올리기" → `<input type=file multiple accept="image/*">`로 고른다.
  3. exifr로 `DateTimeOriginal`을 읽고(없으면 `lastModified`) `isoWeek`로 묶는다.
  4. 주차마다 기존 후보 썸네일과 새 파일을 함께 `analyzeDay`에 넣는다.
  5. 유지·제외 목록을 보여준다(제외 사유 한국어 표시, 탭해서 되살리기).
  6. "올리기": 원본은 `File` 그대로, 썸네일은 canvas 긴 변 1600px JPEG 0.85로 만든다. 진행률을 보여준다. 점수는 `PUT scores`로 갱신한다.
  - 8~16장 권장 문구를 보여주고, 32장을 넘으면 경고한다. `warnings`가 있으면 "얼굴 분석 없이 진행" 안내를 보여준다.
- [ ] **Step 2:** "투표 시작"을 누르면 두 링크(나 / 아내)와 복사 버튼을 보여준다. "PC에서 `npm run funnel:on` 하세요" 안내와 현재 Funnel 상태도 표시한다. `done`이 된 주에는 "`npm run funnel:off` 하세요"를 보여준다.
- [ ] **Step 3: 검증.** 갤럭시(tailnet)에서 10장을 올린다.
  - `pool/<주차>/`의 원본 해시가 휴대폰 원본과 같아야 한다(`certutil -hashfile`과 비교).
  - 흐린 사진 1장이 제외 목록에 나와야 한다.
- [ ] **Step 4:** 커밋 `feat: add admin upload screen`

### Task 7: 투표 화면 (토너먼트·대기·결과 공개·함께 결승)

**Files:**
- Create: `public/vote.html`, `public/vote.js`, `public/vote.css`

**Interfaces:**
- Consumes: Task 5 투표 API(`VoterView`)

- [ ] **Step 1:** 경기 화면을 구현한다. 위아래 두 장, 탭하면 선택하고, `label`과 `index/total`을 표시한다. "되돌리기" 버튼을 두고, 409가 오면 받은 최신 상태로 다시 그린다. 탭 직후 버튼을 잠가 중복 전송을 막는다.
- [ ] **Step 2:** 대기 화면을 구현한다. "상대가 투표 중이에요"를 보여주고 5초마다 `state`를 폴링한다. 상대의 순위는 절대 표시하지 않는다.
- [ ] **Step 3:** 결과 화면을 구현한다. 내 1~3위, 상대 1~3위, 겹친 사진을 차례로 공개하는 연출을 넣는다(CSS 애니메이션, 탭해서 다음). 최종 저장 사진과 "PC에 저장됨"을 표시한다.
  - 함께 결승 상태이면 "둘이 같이 골라요" 화면에서 두 1위를 보여준다. 탭하면 `joint`를 보낸다.
- [ ] **Step 4: 검증 (사용자·아내)**
  - 아내 링크를 데이터망 휴대폰에서 연다. 본인은 갤럭시에서 연다.
  - 동시에 진행하고, 한쪽을 중간에 새로고침해 이어지는지 확인한다.
  - 결과가 공개되고 `selected/`에 1~3장이 생기며, 원본 해시가 일치해야 한다.
- [ ] **Step 5:** 커밋 `feat: add voting tournament screens`

### Task 8: Funnel off 시 토큰 폐기 + README

**Files:**
- Modify: `scripts/funnel.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 4 `createStore(root).revokeDoneTokens()`

- [ ] **Step 1:** `funnel.js off`가 serve 전환 후 `revokeDoneTokens()`를 호출하고 폐기 수를 출력하게 한다.
- [ ] **Step 2:** README에 한 주 사용 순서를 적는다(`npm start` → 관리 화면에서 올리기 → 투표 시작 → `funnel:on` → 링크 전달 → 결과 → `funnel:off`). 첫 설정(`config.json`)과 백그라운드 실행 방법도 적는다.
- [ ] **Step 3: 검증**
  - `npm test`가 전부 통과해야 한다.
  - `done` 주의 아내 링크를 `funnel:off` → `funnel:on` 뒤에 데이터망에서 열면 404여야 한다.
- [ ] **Step 4:** 커밋 `feat: revoke finished vote links on funnel off`

---

## Addendum 2026-11-24: HEIC 지원

Spec: 위 스펙의 "개정 2026-11-24: HEIC 지원" 절.

### Task 9: 브라우저 HEIC 디코딩 + 원본 해상도 JPG 변환

**Files:**
- Create: `public/vendor/libheif/**` (libheif-js wasm 번들 고정 버전, README.txt에 버전·출처·SHA-256)
- Create: `public/decode.js`
- Modify: `public/analyze.js` (디코딩을 `decode.js` 경유로), `public/admin.js` (썸네일 생성이 `decode.js` 경유)
- Test: `test/decode.pure.test.js`

**Interfaces:**
- Produces:
  ```js
  export function isHeic(file: File): boolean      // type image/heic|heif 또는 확장자 .heic/.heif (대소문자 무시)
  export async function decodeToBitmap(file: File, opts?: {resizeWidth?, resizeHeight?}): Promise<ImageBitmap | {width,height,draw(ctx,dw,dh)}>
  export async function toFullJpeg(file: File): Promise<Blob | null>   // HEIC면 원본 해상도 JPEG 0.95, 아니면 null
  ```
  HEIC가 아니면 `createImageBitmap(file, {imageOrientation:'from-image'})`를 그대로 쓴다. HEIC면 libheif로 디코딩한다(회전/미러 변환 적용). 디코딩 실패 시 throw → 호출자가 'unsupported' 처리.

- [ ] **Step 1:** 테스트: `isHeic`이 `a.HEIC`, `b.heif`, type `image/heic`에 true, `c.jpg`에 false. libheif 로더가 `import.meta.url` 기준 로컬 경로만 쓰고 http(s) URL을 쓰지 않음(소스 문자열 검사).
- [ ] **Step 2:** 실패 확인 → 구현 → 통과. `npm test` 전체 통과.
- [ ] **Step 3:** 커밋 `feat: decode HEIC in browser and make full-size JPEG`

### Task 10: HEIC 업로드·보관·최종 JPG 저장

**Files:**
- Modify: `src/routes.js` (업로드 형식), `src/store.js` (`addPhoto`에 `fullJpeg?: Buffer`, finalize), `public/admin.js` (업로드 시 `toFullJpeg` 결과 첨부)
- Test: `test/store.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: Task 9 `isHeic`, `toFullJpeg`
- Produces: 업로드 헤더 `X-Full-Length`(선택). body = 썸네일 + 원본 + (있으면) full JPEG. `addPhoto(week, {..., fullJpeg?})`는 `pool/<주차>/<id>.full.jpg`를 쓴다.
  finalize: `ext`가 heic/heif이면 `.full.jpg`를 `selected/<주차>_<순위>.jpg`로 복사한다. 그 외에는 원본 바이트를 그대로 복사하고 확장자는 `jpg`/`jpeg` → `.jpg`로 쓴다(png/webp는 원래 확장자 유지).

- [ ] **Step 1:** 테스트:
  - HEIC + fullJpeg 업로드 → finalize 후 `selected/<주차>_1.jpg` 바이트 == fullJpeg.
  - JPG 원본은 바이트 그대로이고 이름은 `.jpg`.
  - HEIC인데 fullJpeg 없음 → 업로드 400.
  - `X-Full-Length` 범위 검증(음수, 비정수, 합계 초과 → 400).
  - 50MB 상한은 장당 합계 기준.
- [ ] **Step 2:** 실패 확인 → 구현 → 통과. `npm test` 전체 통과.
- [ ] **Step 3:** 커밋 `feat: store HEIC originals and save JPEG for album`
