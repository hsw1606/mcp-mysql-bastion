# AI Agent Guidelines for mcp-mysql-bastion

## 이 저장소

SSH bastion을 거쳐야만 닿을 수 있는 MySQL을 위한 읽기 전용 MCP 서버. 환경마다
이름 붙은 profile 하나씩을 둔다. stdio로 로컬 MCP 클라이언트(Claude Code, Codex)에만
서비스한다.

[benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql)(MIT)에서
파생됐다. 무엇이 상속이고 무엇이 이 저장소의 것인지는 [README.md](README.md)의
"출처" 절에 있다. 설치·환경 변수·동작 원리는 README가 정본이며, 이 문서는 **코드를
고칠 때 지켜야 할 규칙**만 담는다.

## 언어 정책

- 문서, 소스 주석, 커밋 메시지는 **한국어**로 쓴다
- 코드 식별자(변수·함수·타입·env 변수 이름)는 영어로 쓴다
- MCP 클라이언트로 나가는 문자열은 **그 문자열이 놓인 파일의 기존 언어를 따른다** —
  `index.ts`의 tool description과 오류 메시지는 영어, `src/catalog/render.ts`의 모델
  안내문은 한국어다. 한 파일 안에서 두 언어를 섞지 않는다

## 설계 원칙

이 서버는 모델이 쓰는 도구다. 아래는 여러 PR에 걸쳐 반복해서 내린 결정이므로,
새 기능도 같은 방향으로 만든다.

- **판정은 서버가 아니라 모델이 한다 (MUST).** 서버는 사실과 선택지만 돌려준다.
  "이 쿼리는 느리다", "이 인덱스를 만들어라" 같은 결론을 서버가 내리지 않는다.
  타임아웃 보고서(`src/db/diagnose.ts`)가 이 원칙의 본보기다 — 실패 사실, `EXPLAIN`
  결과, 고를 수 있는 선택지까지만 주고 나머지는 모델이 사용자에게 묻는다
- **규칙 기반 자동 추론을 서버에 넣지 않는다 (MUST).** 이름·컬럼 일치율 같은
  heuristic으로 Node가 스스로 판단하게 만들자는 설계는 한 번 검토한 끝에 버렸다.
  모델이 catalog 도구를 통해 결정하고, 서버는 캐시가 비었을 때 **연결을 유도하는
  안내**를 응답에 붙이는 데 그친다
- **선택지는 모델이 사용자에게 물을 수 있는 형태로 준다 (SHOULD).** "30초로 재시도",
  "재시도 안 함"처럼 다음 행동을 고를 수 있게 제시한다. 네트워크 사정으로 성공해야 할
  쿼리가 실패하는 경우가 실제로 있어서 재시도 경로를 남겨 둔다
- **토큰을 예산으로 다룬다 (SHOULD).** 기동 시에는 꼭 필요한 것만 조회하고, 문서 축은
  지연 수집하며, 앞선 캐시를 재사용한다. tool description에는 클라이언트 상한(Claude
  Code 기준 2048자)이 있고 넘치면 **꼬리부터 말없이 잘리므로**,
  `src/catalog/render.ts`는 바이트가 아니라 글자로 예산을 잰다

## 깨뜨리면 안 되는 것

- **stdout은 MCP 프로토콜 전용 (MUST).** `console.log`와 `console.info`는 둘 다
  stdout에 쓴다. 한 줄만 새어도 클라이언트 handshake가 JSON 파싱 에러로 깨진다.
  진단 출력은 `src/utils/index.ts`의 `log()`를 쓰고, 그것이 닿지 않는 자리에서는
  `console.error`를 직접 쓴다. `bin/`의 wrapper 스크립트도 같은 약속을 지킨다
- **`prod` profile의 쓰기 금지는 설정이 아니라 코드다 (MUST).**
  `src/config/index.ts`의 `WRITE_FORBIDDEN_PROFILES`가 `prod`/`production`에서
  `ALLOW_*`와 `SCHEMA_*_PERMISSIONS`를 강제로 끈다. env 파일·셸 export·클라이언트
  설정을 어떻게 조합해도 뒤집히지 않아야 한다. 이 경로를 우회할 수 있게 만드는 변경은
  하지 않는다
- **비밀값은 저장소에 들어오지 않는다 (MUST).** `.env.*`는 gitignore 대상이고
  `.env.example`만 커밋한다. 새 환경 변수를 추가하면 `.env.example`에 자리표시자와
  설명을 넣되 실제 host·user·password는 절대 쓰지 않는다
- **쿼리 결과를 가공하지 않는다 (MUST).** PII redaction과 리터럴 마스킹 계층은
  의도적으로 걷어냈다. 결과는 있는 그대로 반환한다 — 이유는 README의 "결과는 있는
  그대로 반환합니다" 절에 있다
- **README와 코드가 어긋나면 그것이 버그다 (MUST).** 동작이나 기본값을 바꾸면 같은
  커밋에서 README의 해당 표·절을 고친다. README에만 있는 환경 변수도, 코드에만 있는
  환경 변수도 0개여야 한다

## 되돌린 결정

이미 검토한 끝에 버린 설계가 있다. 같은 안을 다시 제안하기 전에
[references/reverted-decisions.md](references/reverted-decisions.md)에서 왜 버렸는지
확인한다.

## 개발 환경

### 기술 스택

- Node.js 22.12 이상 (`package.json`의 `engines`가 하한 — vitest 5가 요구한다)
- TypeScript 5 strict + ESM (`module`/`moduleResolution`: `NodeNext`)
- `@modelcontextprotocol/sdk`, `mysql2`, `ssh2`, `node-sql-parser`, `dotenv`
- 테스트는 vitest

### 구성

디렉터리별 역할은 [README.md](README.md)의 "구성" 절이 정본이다. 디렉터리를
더하거나 옮기면 그 절을 고친다.

### 명령

```bash
npm install
npm run build          # tsc + dist/index.js 실행 권한
npm run watch          # tsc --watch
npm test               # tsc -p tsconfig.test.json && vitest run
npm run test:watch     # vitest
npm run start:stage    # bin/mcp-mysql-stage.sh
npm run start:prod     # bin/mcp-mysql-prod.sh
```

- linter는 없다. 유일한 정적 게이트는 **strict 모드 `tsc`**이므로, 타입으로 막을 수
  있는 것은 타입으로 막는다
- `npm test`는 타입 검사와 vitest를 함께 돌린다. 테스트만 통과시키고 타입 오류를 남긴
  상태로 커밋하지 않는다

## 코딩 표준

- MUST 내부 import에 `.js` 확장자를 붙인다 (`../utils/index.js`). NodeNext 해석에서
  확장자 없는 경로는 런타임에 실패한다
- MUST 환경 변수는 `src/config/index.ts`에서만 읽고, 다른 모듈은 거기서 export한
  상수를 import한다
- MUST 숫자 환경 변수는 `parsePositiveInt`로 읽는다. `parseInt`를 그대로 쓰면 빈
  문자열이나 잘못된 값에서 `NaN`이 mysql2까지 흘러간다. 잘못된 값은 stderr로 알리고
  기본값으로 계속 간다
- MUST README의 환경 변수 표에 올린 값은 실제로 읽는다. 표에 있는데 코드가
  하드코딩하고 있으면(과거의 `MYSQL_POOL_SIZE`가 그랬다) 그것은 버그다
- MUST **이름은 그것이 실제로 하는 일을 말한다.** `sql_select_limit`이 응답 행 수를
  자르는 상한인데 이름이 SQL 변수처럼 읽혀 오해를 불렀고, 그래서
  `MYSQL_MAX_RESPONSE_ROWS`로 바꿨다. 이름이 오해를 부르면 이름을 고친다
- MUST 설정 오류 하나로 서버를 죽이지 않는다. `MYSQL_APP_SCHEMAS`의 잘못된 항목,
  깨진 catalog 파일처럼 **한 조각의 실패는 알리고 건너뛴다**. 서버 자체를 못 쓰게
  만드는 실패(읽을 수 없는 `MYSQL_ENV_FILE`)만 던진다
- MUST `index.ts`는 MCP 배선(tool·resource handler 등록, 종료 처리)에 머무르고,
  판단하는 로직은 `src/` 아래 모듈에 둔다 — 테스트가 부를 수 있는 자리에 두라는 뜻이다
- MUST 문서·주석·PR 본문의 수치는 **실측값**으로 맞춘다. 한 곳을 고치면 같은 수치가
  적힌 다른 곳도 함께 고친다
- SHOULD 주석은 코드가 이미 말하는 것을 되풀이하지 않는다. **왜 다른 선택지를
  버렸는지**를 적는다. 상한을 일부러 걸지 않은 자리, 비슷한 이름의 두 함수
  (`executeQuery` / `executeReadOnlyQuery`)처럼 다음에 읽는 사람이 헷갈릴 곳에는
  근거를 남긴다. 기존 주석(`test/setup.ts`, `src/utils/index.ts`의 `log`,
  `src/config/index.ts`의 profile 정책)이 본보기다
- SHOULD `.env.example`의 주석을 고치면 로컬의 `.env.prod`·`.env.stage`에도 같은
  주석을 반영해 세 파일을 한 몸으로 유지한다 (값은 각자, 설명은 동일)

## 테스트와 검증

- MUST 테스트는 실제 MySQL이나 bastion에 붙지 않는다. 플랜은 `test/fixtures/`에 받아 둔
  실제 `EXPLAIN FORMAT=JSON` 출력을 쓴다
- MUST `test/setup.ts`를 우회하지 않는다. 이 파일은 `MYSQL_ENV_FILE`을 빈 fixture로
  고정해 개발자의 실제 `.env.prod`(MYSQL_PASS와 `ALLOW_*`까지)가 테스트로 실리는 것을
  막는다. `setupFiles`에 있어야만 정적 import보다 먼저 돈다
- MUST 새로 내린 결정은 테스트로 고정한다. 이 저장소의 테스트는 커버리지가 아니라
  **되돌아가면 안 되는 결정**을 지키는 장치다
- MUST 모델·사용자와 닿는 경로를 바꿨으면 **stage profile로 실제 MCP 서버를 띄워**
  확인한다. 유닛 테스트 통과만으로 "동작한다"고 보고하지 않는다
- SHOULD 테스트 설명은 무엇을 검사하는지 한국어 문장으로 쓴다
  (예: `test("주어진 예산을 절대 넘지 않는다", ...)`)

## 데이터베이스 접근

- MUST PROD와 STAGE 데이터베이스 조회는 **MySQL MCP 도구로만** 한다
  (`mysql-prod`, `mysql-stage`). AWS CLI, SSH, 로컬 클라이언트, 직접 연결은 쓰지 않는다
- 이 서버를 고치다 실제 동작 확인이 필요하면 stage profile에서 읽기만 한다

## Git

- MUST 기능 단위 브랜치에서 작업하고 `main`에 직접 커밋하지 않는다
- MUST 커밋 제목은 conventional prefix + 한국어 현재형으로 쓴다
  (`fix: 깨진 catalog 파일이 카탈로그를 끄지 않는다`)
- MUST 커밋 본문에 **왜**를 적는다. 무엇을 고쳤는지는 diff가 말한다. 무엇이 틀렸고,
  왜 그 선택을 했고, 무엇을 검증했는지를 쓴다
- MUST 관심사가 다르면 커밋을 나눈다. 한 PR은 한 가지 관심사만 다룬다
- MUST 코드를 고쳤으면 **PR 본문도 같이 갱신한다**. 본문에 커밋 목록 표는 넣지 않는다
