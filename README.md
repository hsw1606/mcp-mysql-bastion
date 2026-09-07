# mcp-mysql-bastion

SSH bastion을 거쳐야만 닿을 수 있는 MySQL을 위한 읽기 전용 MCP 서버. 환경마다
이름 붙은 profile 하나씩을 둡니다.

Tunnel은 서버가 직접 엽니다. 이미 쓰고 있는 `~/.ssh/config` alias 하나만 가리켜
주면 forwarding, connection pool, teardown까지 알아서 처리합니다. `prod`라는 이름의 profile은
쓰기가 불가능하며, 이는 설정이 아니라 코드에서 결정됩니다.

## 출처

[benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql)(MIT)에서
파생됐습니다. MCP 서버, 쿼리 routing, 권한 모델, PII redaction은 그 프로젝트에서
왔습니다. [LICENSE.md](LICENSE.md)를 참고하세요.

이 저장소에서 새로 추가된 것: SSH tunnel 계층(`src/ssh/`), profile 체계, wrapper
스크립트, stderr 전용 로깅. 원격 HTTP transport, test suite, eval harness,
Docker packaging은 걷어냈습니다 — 이 서버는 로컬 MCP 클라이언트에 stdio로
서비스할 뿐, 그 외의 일은 하지 않습니다.

## 제공하는 것

- **SSH tunnel.** Connection pool이 생기기 전에 열리고, 종료 시 닫힙니다. 각 서버가
  자기 tunnel을 소유하므로 instance끼리 간섭하지 않습니다.
- **Profile.** `MYSQL_PROFILE`이 `.env.<profile>`을 고릅니다. 모든 응답이 어느
  환경에서 온 답인지 밝힙니다.
- **기본 읽기 전용, prod는 깨뜨릴 수 없음.** `prod`/`production`은 설정과
  무관하게 모든 쓰기를 거부합니다.
- **Map은 탐색이 아니라 선언.** 각 profile이 어떤 schema가 어떤 application의
  것인지, 데이터가 어느 git branch에 대응하는지를 명시하므로, 모델은 이를
  뒤져서 알아내는 대신 툴 설명에서 읽습니다.
- **로컬 schema catalog.** 선언된 schema의 table 목록을 시작할 때 한 번 읽고,
  실제 query에 등장한 table의 column·index·foreign key를 필요할 때만 수집합니다.
- **stdio에 안전한 로깅.** 모든 진단 출력이 stderr로 가므로
  `ENABLE_LOGGING=true`가 MCP 스트림을 망가뜨리는 일이 없습니다.

## 요구 사항

- Node.js 20 이상
- Bastion에 대한 SSH 접근 권한, 그리고 이미 동작하는 키(`ssh <alias>`가 성공할 것)
- 대상 데이터베이스의 MySQL 사용자 계정

## 설치

### 1. 설치와 빌드

```bash
git clone <this repo>
cd mcp-mysql-bastion
npm install
npm run build
```

빌드는 `dist/index.js`를 만들며, MCP 클라이언트가 실행하는 것이 바로 이 파일입니다.

### 2. `~/.ssh/config`에 bastion 기술하기

서버는 필요한 정보를 Host alias에서 모두 읽어올 수 있습니다. 이렇게 하면
credentials과 호스트명을 이 저장소 바깥에 온전히 둘 수 있습니다:

```sshconfig
Host my-stage-db
    HostName bastion.stage.example.com
    User dev
    LocalForward 3307 db-stage.cluster-ro.example.rds.amazonaws.com:3306
```

`HostName`, `User`, `Port`, `IdentityFile`, 그리고 첫 번째 `LocalForward`를
읽어갑니다. 다음 단계로 넘어가기 전에 alias 자체가 동작하는지 확인하세요:

```bash
ssh my-stage-db "echo ok"
```

### 3. Profile 만들기

```bash
cp .env.example .env.stage
chmod 600 .env.stage
```

alias이 있다면 profile은 짧습니다:

```dotenv
MYSQL_PROFILE=stage

MYSQL_SSH_ENABLED=true
MYSQL_SSH_CONFIG_HOST=my-stage-db

MYSQL_USER=<user>
MYSQL_PASS=<password>
MYSQL_DB=

ALLOW_INSERT_OPERATION=false
ALLOW_UPDATE_OPERATION=false
ALLOW_DELETE_OPERATION=false
ALLOW_DDL_OPERATION=false
```

multi-DB 모드(`SHOW DATABASES`, schema 간 쿼리)를 쓰려면 `MYSQL_DB`를 비워
두세요. `.env.prod`도 `MYSQL_PROFILE=prod`로 같은 방식으로 만듭니다.

`.env.*` 파일은 gitignore 대상이며, 커밋되는 것은 `.env.example`뿐입니다.
커밋되는 파일에는 절대 실제 비밀번호를 넣지 마세요.

### 4. 등록하기 전에 profile 점검하기

Wrapper를 직접 실행하세요. env 파일, credentials, SSH 키를 검증한 뒤 stdin에서 MCP
트래픽을 기다립니다:

```bash
./bin/mcp-mysql-stage.sh
```

아무 출력이 없으면 성공입니다 — 서버가 떴고 stdout이 깨끗하다는 뜻입니다.
`Ctrl-C`로 중단하세요. 설정이 잘못됐다면 이유를 stderr에 찍고 0이 아닌 코드로
종료합니다.

무슨 일을 하는지 보고 싶다면 profile에 `ENABLE_LOGGING=true`를 넣고 `[ssh]`
줄을 확인하세요:

```text
[ssh] resolved alias "my-stage-db" from ~/.ssh/config: {...}
[ssh] opening tunnel dev@bastion.stage.example.com:22 -> db-stage.cluster-ro.example:3306 (local port 3307)
[ssh] tunnel listening on 127.0.0.1:3307
```

### 5. Claude Code에 등록하기

절대 경로를 쓰세요 — 클라이언트는 `~`나 상대 경로를 해석하지 않습니다:

```bash
claude mcp add mysql-stage -s user -- /absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-stage.sh
claude mcp add mysql-prod  -s user -- /absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-prod.sh
```

`-s user`는 모든 프로젝트에 등록합니다. 현재 프로젝트로만 한정하려면
`-s local`을 쓰세요. 확인:

```bash
claude mcp list
```

둘 다 `✔ Connected`로 나와야 합니다. 등록 내용은 `~/.claude.json`의 최상위
`mcpServers` 키에 들어갑니다. 이 파일은 프로젝트별 상태도 함께 담고 있으니
직접 편집하기보다 CLI를 쓰는 편이 좋습니다.

나중에 경로를 바꾸려면 제거 후 다시 추가하세요:

```bash
claude mcp remove mysql-stage -s user
claude mcp add mysql-stage -s user -- /new/path/bin/mcp-mysql-stage.sh
```

이미 열려 있는 세션에서 돌고 있는 서버는 그 세션을 재시작하기 전까지 이전
경로를 그대로 씁니다.

### 6. Codex에 등록하기

Codex에는 `mcp add`가 없으므로 `~/.codex/config.toml`에 추가하세요 — 덮어쓰지
말고 append 해야 합니다:

```toml
[mcp_servers.mysql-stage]
command = "/absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-stage.sh"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.mysql-prod]
command = "/absolute/path/to/mcp-mysql-bastion/bin/mcp-mysql-prod.sh"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 120
```

먼저 파일을 백업하세요. 다른 MCP 서버들과 그 credentials이 함께 들어 있는
파일입니다.

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.bak
codex mcp list          # 둘 다 enabled로 보여야 합니다
```

**timeout에 대해.** `startup_timeout_sec`은 MCP handshake만 포함하며, 여기서는
0.2초 정도 걸립니다 — tunnel은 시작 시점이 아니라 첫 쿼리에서 지연 생성되므로
`initialize`를 막지 않습니다. 첫 쿼리가 SSH handshake 비용을 치르며 3초 안팎이
걸리는데, `tool_timeout_sec`이 감당해야 하는 것이 이 값입니다. 위 설정값은 실측치의
대략 10배입니다.

**sandbox에 대해.** MCP 서버는 `sandbox_mode`가 Codex 자체 shell에 적용하는
sandbox 바깥에서 돌아갑니다. 따라서 서버가 SSH 키를 읽거나 bastion에 닿기 위해
sandbox 설정을 바꿀 필요는 없습니다.

전 구간 확인:

```bash
codex exec "Using mysql-stage, run: SELECT 1"
```

## 사용법

Profile 이름으로 물어보면 답변에 환경이 함께 돌아옵니다:

```text
Using mysql-stage, how many rows are in app.users?
```

```text
[profile: STAGE | read-only | database: multi-db | code: develop branch | ssh tunnel: dev@bastion.stage.example.com -> db-stage.cluster-ro.example:3306]
[
  {
    "c": 13369
  }
]
```

모든 응답이 — 성공이든 거부든 — 이 banner를 달고 나오므로 stage 결과를 prod
결과로 착각할 수 없습니다. 툴 설명에도 환경 이름이 들어갑니다. 모델이 툴을
고르기 전에 읽는 것이 바로 툴 설명이기 때문입니다.

## 모델에게 무엇이 어디 있는지 알려주기

내버려 두면 모델은 "lead는 어느 schema에 있지?"라는 질문에 `SHOW DATABASES`와
`information_schema` 쿼리 몇 번, 그리고 추측으로 답합니다. 하나하나가 왕복
비용이고, 추측은 가끔 틀립니다. 모델에게 없는 이 두 가지 사실은 운영자가 이미
알고 있는 것이므로, profile이 이를 명시합니다.

### `MYSQL_APP_SCHEMAS` — 어떤 schema가 어떤 앱의 것인가

항목 구분자는 `;` 또는 개행입니다 — 쉼표가 아니므로 설명을 문장처럼 쓸 수
있습니다. 각 항목은 `app:schema`, 또는 `app:schema:설명` 형식입니다:

```dotenv
MYSQL_APP_SCHEMAS="core-api:haulla:Main product service - the primary schema;
core-api:haulla-shared:Tenant-shared data, also owned by core-api;
tycoon-api:tycoon:Internal sales/CRM tool"
```

한 앱이 여러 번 나올 수 있습니다. 테넌트별 schema와 공용 schema를 함께 갖는
서비스는 둘 다 적으세요 — 뒤엣것만 남기면 모델에게 필요한 schema가 사라집니다.
같은 `app:schema` 쌍이 정확히 반복될 때만 실수로 봅니다. 설명에는 `;`를 쓸 수
없습니다. 항목이 쪼개집니다.

이 map은 툴 설명 뒤에 붙습니다. 모델이 첫 호출 전에 읽는 것이 툴 설명입니다:

```text
APP -> SCHEMA (authoritative — use these directly; do not run SHOW DATABASES
or search information_schema to find a schema):
  - core-api -> haulla — Main product service - the primary schema
  - core-api -> haulla-shared — Tenant-shared data, also owned by core-api
  - tycoon-api -> tycoon — Internal sales/CRM tool
  ...
```

**여기에는 migration을 넘겨서도 살아남는 사실만 적으세요.** schema의 테이블
목록을 나열하면 `SHOW TABLES` 한 번을 아끼는 대신 조용히 낡습니다. 그리고 이
map은 authoritative하다고 선언되므로, **틀린 목록은 없는 목록보다 나쁩니다** —
모델이 "그런 테이블은 없다"고 단정해 버립니다. 어떤 앱이 어떤 schema를 쓰는지는
사람만 알고 데이터베이스에 물어볼 수 없는 사실이지만, 그 schema에 어떤 테이블이
있는지는 catalog가 데이터베이스에서 자동으로 갱신합니다.

resource를 읽는 클라이언트를 위해 `mysql://schemas` resource로도 제공됩니다. 이름이
단순 식별자가 아닌 schema(`haulla-shared`)가 있으면 backtick으로 감싸야 한다는
안내가 덧붙습니다. 이 map이 유발할 수 있는 유일한 문법 오류가 그것이기
때문입니다.

이 map은 filter가 아니라 문서입니다 — 무엇을 쿼리할 수 있는지는 제한하지
않습니다. 설정하지 않으면 이전 동작 그대로입니다.

형식이 잘못된 항목은 stderr에 보고하고 건너뜁니다. 오타 하나 때문에 map 전체를
잃어서는 안 되므로, 나머지 항목은 그대로 로드됩니다.

### Schema catalog — 이미 알아낸 구조를 다시 찾지 않기

서버는 `MYSQL_APP_SCHEMAS`에 선언된 schema만 로컬 JSON catalog에 기록합니다.
시작할 때 table 이름·comment·예상 row 수를 query 한 번으로 갱신합니다. Column,
primary key, index, foreign key는 table이 실제 SQL에 처음 등장한 뒤 비동기로
수집합니다. 이 작업은 `mysql_query`의 실행 시간에 포함되지 않습니다.

모델은 `mysql_catalog` action으로 DB를 다시 탐색하지 않고 구조를 읽습니다:

- `map`: application, schema, 자주 쓰는 table의 개요를 봅니다.
- `search`: table·수집된 column·memo·alias를 keyword로 찾습니다.
- `describe`: 한 table의 column, key, index, foreign key를 봅니다. 상세 정보가
  아직 없거나 TTL이 지났다면 이 호출이 갱신을 기다립니다.
- `docs_list`: schema를 소유한 application 아래의 `model.md` 후보만 봅니다.
  범위는 `MYSQL_APP_SCHEMAS`의 application 이름을 저장소의 `apps/<application>/`
  directory로 보고 좁힙니다. 응답의 `scopedToApp`이 이 규약이 적용됐는지 알려주고,
  범위 밖 문서 수를 함께 보고합니다. 규약에 맞는 문서가 없으면 전체 목록을
  반환하고 그 이유를 `notice`에 적습니다. 범위 밖 경로도 `docs_read`로는 읽히며
  `map`의 `unlinkedDocuments`에 나타납니다.
- `docs_read`: shell을 쓸 수 없는 클라이언트에서도 선택한 문서의 최신 내용을
  읽습니다.
- `link`: 모델이 판단한 table↔문서 연결을 배열로 한꺼번에 저장합니다.
- `unlink`: 연결을 지우거나 해당 table에 연결할 문서가 없음을 기록합니다.
- `note`: `target` table에 memo 또는 alias 하나를 저장합니다. 둘 중 하나만 보냅니다.
  Table당 memo 50개, alias 20개까지이며 한도에 닿으면 저장을 거절합니다. 사람과
  모델이 쓴 내용을 서버가 조용히 버리지 않기 위한 것이고, 정리는 `forget`으로 합니다.
- `forget`: `target` table의 `notes`, `aliases`, `usage`, `joins`, `metadata` 중 한
  범위를 지웁니다. `metadata`는 다음 `describe` 또는 정상 query 뒤에 다시 수집됩니다.
  문서 판단은 지우지 않으며, 그 작업에는 `unlink`를 사용합니다.
- `refresh`: 지정한 범위를 강제로 다시 수집합니다. `target`이 `schema.table`이면
  그 table의 column·index·foreign key, 선언된 schema 이름이면 table inventory,
  `docs`면 문서 ref입니다. `target`을 생략하면 inventory와 문서를 함께 갱신합니다.

문서 catalog는 서버 시작 시 git을 실행하지 않습니다. 첫 `docs_list`, `docs_read`,
`describe`, `map` 호출이나 문서 미확인 table의 query가 있을 때 한 번 깨어납니다.
항상 local working tree가 아니라 `origin/<MYSQL_CODE_BRANCH>`를 읽으며, 서버가
`fetch`, `checkout`, `pull`을 실행하는 일은 없습니다.

Catalog에는 문서 내용이 아니라 경로와 ref commit만 저장됩니다. Ref가 바뀌면 추가와
삭제를 반영하고, git이 보고한 rename은 기존 table 연결에도 그대로 적용합니다.
내용 수정은 경로를 낡게 만들지 않으므로 별도 작업을 하지 않습니다. 연결된 문서는
`describe` 응답에서 경로, ref, 바로 실행할 수 있는 `git show` 명령을 함께 제공합니다.
마지막 ref commit이 30일보다 오래됐으면 동작은 계속하되 응답에 경고를 붙입니다.

Query가 없는 column이나 table을 참조해 실패하면 서버는 해당 항목을 즉시 stale로
표시하고 다시 수집합니다. 이 자동 무효화는 catalog가 실제보다 **많이** 알고 있는
경우만 잡아냅니다. Migration이 column, index, foreign key를 **추가**한 경우는
오류가 나지 않으므로 아무것도 stale이 되지 않고, catalog는 TTL이 지날 때까지 덜
알고 있는 상태로 답합니다. 이쪽이 더 위험합니다. 새로 생긴 `deletedAt`을 모르는
상태로 쓴 SQL은 성공하면서 삭제된 row를 조용히 함께 반환합니다. Migration 직후나
결과가 catalog의 설명과 어긋날 때 `refresh`를 쓰십시오. 비용은 query 한 번입니다.

Catalog는 기본적으로
`~/.cache/mcp-mysql-bastion/catalog/<profile>-<database-target-hash>.json`에
저장됩니다. SSH를 쓰면 `LocalForward`의 원격 host·port를, 직접 연결하면 MySQL
host·port 또는 socket 경로를 hash에 사용합니다. 파일 mode는 `0600`입니다.
Profile과 실제 DB 대상이 파일명에 들어가므로 서로 다른 환경이 같은 catalog를
읽지 않습니다. 디스크에 쓸 수 없으면 서버는 catalog만 끄고 기존 query 기능을
계속 제공합니다. 다른 서버가 파일 lock을 오래 쥐고 있거나 파일 내용이 깨진 경우는
복구 가능한 상황으로 보고 catalog를 끄지 않습니다. 앞의 경우는 다음 저장에서 다시
시도하고, 뒤의 경우는 읽을 수 없는 파일을 새로 쓴 내용으로 교체합니다.

Catalog에는 schema metadata, 사용 횟수, literal을 `?`로 바꾼 SQL 지문만
들어갑니다. SQL 원문과 row data는 저장하지 않습니다. PII redaction이 켜지면 PII
column은 저장과 응답에서 모두 제외합니다. `MYSQL_CATALOG_ENABLED=false`로 끄면
도구와 resource 동작은 변경 전과 같아집니다.

Query 뒤에는 참조한 table의 호출 횟수와 최근 시각을 기록합니다. 실패한 query도
횟수에 들어가며, 성공과 실패를 따로 셉니다.

Hot table 순위는 **성공한 query 횟수**를 기준으로 정하고 최근 시각으로 동률을
정합니다. 실패한 query는 모델이 그 table을 읽지 못했다는 뜻이라 순위에 반영하지
않습니다. `map`은 schema마다 상위 10개를 보여주며, 여기서는 관측이 없는 table을
예상 row 수로 이어 붙입니다. `mysql_query` 도구 설명에 들어가는 전체 상위 10개는
**한 번이라도 읽힌 table만** 담습니다. 읽힌 table이 없으면 목록 자체를 넣지
않습니다. 예상 row 수로 빈자리를 채우면 가장 큰 event·log table이 열 칸을
차지해서, 모델을 시작하면 안 되는 곳으로 밀기 때문입니다.

이 목록이 처음 채워지는 시점은 서버 시작이 아니라 table을 읽은 첫 query입니다.
서버는 그때 `tools/list_changed` 알림을 세션당 한 번만 보냅니다.

Query에서 `tableA.column = tableB.column` 형태로 관측한 join은 양 끝과 횟수,
마지막 관측 시각만 저장합니다. 성공한 query의 join만 누적하며, `describe`의
`observedJoins`에서 해당 table과 연결된 경로를 자주 관측한 순서로 확인할 수
있습니다. 이는 DB의 foreign key와 별개인 관측 사실입니다. 간선은 500개까지
유지하고 넘으면 가장 오래 관측되지 않은 것부터 버립니다. 횟수가 아니라 시각을
기준으로 버리는 이유는, 드문 간선을 먼저 버리면 나중에 발견한 join 경로가
한도를 넘어 들어올 수 없게 되기 때문입니다.

### `MYSQL_CODE_BRANCH` — 데이터가 어느 branch에 대응하는가

행과 코드를 대조하는 모델에게는 올바른 checkout이 필요한데, 틀렸을 때 조용히
실패합니다. stage column을 `main` 기준으로 읽으면 branch가 잘못된 것이 아니라
migration이 빠진 것처럼 보이기 때문입니다. 그래서 각 profile이 자기 branch를
명시하며, 이 값은 툴 설명과 응답 banner 양쪽에 나타납니다:

```dotenv
MYSQL_CODE_BRANCH=develop    # .env.stage
MYSQL_CODE_BRANCH=main       # .env.prod
```

설정하지 않으면 profile에 따라 기본값이 정해집니다 —
`stage`/`staging`/`dev`/`develop`은 `develop`, `prod`/`production`은 `main`이며,
그 밖의 profile에서는 아무것도 말하지 않습니다.

## 환경 변수

### Profile

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MYSQL_PROFILE` | *(미설정)* | 환경 label. `prod`/`production`은 읽기 전용을 강제합니다. |
| `MYSQL_ENV_FILE` | *(미설정)* | `.env.<profile>` 대신 정확히 이 env 파일을 로드합니다. |
| `MYSQL_APP_SCHEMAS` | *(미설정)* | `;`로 구분된 `app:schema[:설명]` 항목. 툴 설명과 `mysql://schemas`에 노출됩니다. |
| `MYSQL_CODE_BRANCH` | profile별 | 이 환경의 데이터가 대응하는 git branch. `stage`→`develop`, `prod`→`main`. |
| `MYSQL_CATALOG_ENABLED` | `true` | 로컬 schema catalog를 켭니다. `false`이면 기존 동작을 유지합니다. |
| `MYSQL_CATALOG_PATH` | `~/.cache/mcp-mysql-bastion/catalog` | profile·host별 JSON 파일을 둘 directory입니다. |
| `MYSQL_CATALOG_TTL_HOURS` | `24` | DB metadata를 stale로 보는 시간입니다. |
| `MYSQL_DOCS_REPO` | *(미설정)* | `model.md`가 있는 git 저장소. 미설정이면 문서 catalog만 비활성입니다. |

### SSH tunnel

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MYSQL_SSH_ENABLED` | `false` | 접속 전에 tunnel을 엽니다. |
| `MYSQL_SSH_CONFIG_HOST` | *(미설정)* | `HostName`, `User`, `Port`, `IdentityFile`, 첫 `LocalForward`를 읽어올 `~/.ssh/config`의 Host alias. |
| `MYSQL_SSH_HOST` | alias에서 | bastion 호스트명. |
| `MYSQL_SSH_PORT` | `22` | bastion SSH 포트. |
| `MYSQL_SSH_USER` | alias에서 | bastion 사용자. |
| `MYSQL_SSH_PRIVATE_KEY_PATH` | `~/.ssh/id_rsa` | bastion 인증에 쓰는 키. |
| `MYSQL_SSH_PASSPHRASE` | *(미설정)* | 암호화된 키일 때만 필요합니다. |
| `MYSQL_SSH_LOCAL_PORT` | alias `LocalForward`, 없으면 `0` | 선호하는 loopback 포트. `0`은 자동 할당. 포트가 이미 쓰이고 있으면 자동 할당된 포트를 대신 씁니다. |
| `MYSQL_SSH_REUSE_EXISTING` | `false` | 직접 열지 않고 해당 포트에 이미 떠 있는 forward에 붙습니다. 아래 경고를 참고하세요. |

명시적으로 지정한 변수가 항상 alias보다 우선하므로, `~/.ssh/config`를 건드리지
않고 한 profile에서 필드 하나만 덮어쓸 수 있습니다.

### MySQL

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | tunnel을 쓸 때는 **bastion에서 바라본** 데이터베이스 — pool이 접속하는 주소가 아니라 forwarding 대상입니다. alias의 `LocalForward` 대상이 우선합니다. |
| `MYSQL_PORT` | `3306` | 위와 같습니다. |
| `MYSQL_USER` / `MYSQL_PASS` | — | 데이터베이스 credentials. 필수입니다. |
| `MYSQL_DB` | *(비어 있음)* | 비어 있으면 multi-DB 모드가 켜집니다. |
| `MYSQL_POOL_SIZE` | `10` | pool 크기. |
| `MYSQL_CONNECT_TIMEOUT` | `10000` | 접속 timeout(ms). |
| `MYSQL_BIG_NUMBER_STRINGS` | `false` | BIGINT/DECIMAL을 문자열로 반환합니다. schema가 snowflake ID를 쓴다면 켜세요. |
| `MYSQL_DATE_STRINGS` | `false` | 날짜를 `Date`가 아닌 문자열로 반환합니다. |
| `MYSQL_SSL` | `false` | MySQL로의 TLS(SSH tunnel과는 별개). |

### 쓰기

모두 기본값은 `false`이며, 쓰기 금지 profile에서는 어떤 값을 넣든 `false`로
강제됩니다.

| 변수 | 의미 |
| --- | --- |
| `ALLOW_INSERT_OPERATION` | INSERT 허용. |
| `ALLOW_UPDATE_OPERATION` | UPDATE 허용. |
| `ALLOW_DELETE_OPERATION` | DELETE 허용. |
| `ALLOW_DDL_OPERATION` | CREATE/ALTER/DROP/TRUNCATE 허용. |
| `MULTI_DB_WRITE_MODE` | multi-DB 모드에서의 쓰기 허용. |
| `SCHEMA_*_PERMISSIONS` | schema별 override, `"db1:true,db2:false"`. |

### 진단

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `ENABLE_LOGGING` | `false` | 진단 출력을 stderr로. 어떤 MCP 클라이언트에서도 안전합니다. |
| `ENABLE_PII_REDACTION` | `false` | 결과에서 PII로 보이는 값을 redaction 처리합니다. 원본 프로젝트에서 물려받았습니다. |

## Tunnel이 동작하는 방식

Forwarding은 `ssh -N -L`을 spawn 하는 대신 `ssh2`를 통해 프로세스 내부에서
이뤄집니다. loopback listener 하나가 SSH 연결 하나를 앞에서 받고, 수락된 socket마다
자기 `forwardOut` channel을 갖습니다. 그 결과 pool은 SSH 세션 하나 위에서 서로
독립적인 MySQL connection 여러 개를 갖게 됩니다.

자식 프로세스 대신 이 방식을 고른 이유는 세 가지입니다:

1. **Teardown이 구조적으로 보장됩니다.** tunnel의 수명이 곧 프로세스의 수명입니다.
   서버보다 오래 살아남을 자식이 없으므로, forwarding된 포트를 붙잡은 채 남아
   있는 `ssh`라는 실패 양상 자체가 존재하지 않습니다.
2. **준비 완료 시점이 정확합니다.** "포트가 listening을 시작한 뒤에만 pool을
   만든다"가 polling이 아니라 `server.listen()` callback입니다.
3. **남의 stderr를 떠안지 않습니다.** spawn된 `ssh`는 자기 경고를 뱉고, 어떤
   bastion은 말이 많습니다. 여기서는 그것이 stdout에 닿을 수 없습니다.

알아둘 만한 동작:

- Listener는 `127.0.0.1`에만 bind 합니다. forwarding된 데이터베이스에 인증 없이
  접근할 수 있게 해주므로, 네트워크에서 절대 닿을 수 있어서는 안 됩니다.
- **각 서버는 자기 tunnel을 소유합니다.** `MYSQL_SSH_LOCAL_PORT`는 요구 사항이
  아니라 선호일 뿐입니다. 포트가 이미 쓰이고 있으면 이 서버는 OS가 할당한
  포트에 자기 tunnel을 엽니다. pool은 어디로 접속할지 전달받으므로 뒷단에서는
  포트 번호에 신경 쓰지 않습니다.
- 예기치 않게 끊기면 SSH transport를 지수 backoff(1초, 2초, 4초)로 최대 세 번
  다시 세웁니다. 그 뒤에는 알 수 없는 `ECONNRESET` 대신 명시적인 메시지와
  함께 쿼리가 실패합니다.
- Teardown은 `SIGINT`, `SIGTERM`, 그리고 클라이언트가 stdin을 닫을 때 일어납니다.

### 기본값에서 tunnel을 공유하지 않는 이유

이전 버전은 SSH 세션을 하나 더 여는 것을 피하려고, profile 포트에 이미 떠 있는
forward가 있으면 거기에 붙었습니다. 결과적으로 잘못된 선택이었습니다.

빌려 쓴 tunnel은 그것을 연 프로세스와 생사를 함께하는데, MCP 클라이언트는 서버를
쉴 새 없이 띄우고 내립니다 — `codex exec`는 호출이 끝날 때마다 자기 서버를
내립니다. 그래서 소유자가 먼저 종료되는 일이 흔하고, 그때마다 빌려 쓰던 쪽의
진행 중인 쿼리가 `PROTOCOL_CONNECTION_LOST`로 죽습니다. 겉보기에는 간헐적이고
재현되지 않는 툴 실패로 나타납니다.

서버마다 tunnel을 소유하면 SSH 세션 하나를 더 쓰는 대신 이 실패 양상이 통째로
사라집니다. `MYSQL_SSH_REUSE_EXISTING=true`는 forward가 외부에서 관리되고 모든
클라이언트보다 오래 사는 경우 — 직접 띄워 둔 장수 `ssh -L` 같은 경우 — 에만
켜세요.

## 읽기 전용 강제

Profile 이름이 `prod` 또는 `production`이면 `src/config/index.ts`가
`ALLOW_INSERT`, `ALLOW_UPDATE`, `ALLOW_DELETE`, `ALLOW_DDL`,
`MULTI_DB_WRITE_MODE`를 `false`로 강제하고 `SCHEMA_*_PERMISSIONS` override를
비웁니다.

핵심은 override를 비우는 부분입니다. 이들은 전역 flag에 대한 schema별
예외이므로, 그대로 두면 `SCHEMA_UPDATE_PERMISSIONS=some_db:true`가 방금 전역
거부로 닫은 문을 다시 열어버립니다. routing logic이 앞으로 refactoring될 경우를
대비한 2차 방어선으로, `executeWriteQuery`도 별도로 거부합니다.

실질적인 귀결: 어떤 env 파일도, shell export도, MCP 클라이언트 설정도 prod
profile이 쓰게 만들 수 없습니다. 시도하면 무시된 flag를 stderr에 기록하고
읽기 전용으로 계속 동작합니다.

다른 profile은 기본적으로 읽기 전용이지만 켤 수 있습니다. 그쪽의 `ALLOW_*`
flag는 평범한 설정이기 때문입니다.

## 문제 해결

**클라이언트가 handshake 또는 JSON parsing 오류를 보고합니다.** 무언가가 MCP
framing을 나르는 stdout에 썼다는 뜻입니다. 이 서버는 모든 로깅을 stderr로
보내므로, 시작할 때 뭔가를 출력하는 shell profile(`~/.zshrc`, `~/.bash_profile`)이나
custom wrapper를 의심하세요. 확인 방법:

```bash
./bin/mcp-mysql-stage.sh < /dev/null | head
```

출력이 조금이라도 있다면 그것이 버그입니다.

**`SSH private key not found` 또는 권한 오류.** 키 경로가 틀렸거나 읽을 수
없습니다. `MYSQL_SSH_PRIVATE_KEY_PATH`의 기본값은 `~/.ssh/id_rsa`이며, 키는
`chmod 600`이어야 하고 암호화되어 있다면 `MYSQL_SSH_PASSPHRASE`가 필요합니다.

**`Local port N is already in use`.** 무언가가 포트를 잡고 있으면서 우리 탐지에
응답하지 않았습니다. `lsof -nP -i :N`으로 찾거나, `MYSQL_SSH_LOCAL_PORT=0`으로
자동 할당하세요.

**한동안 잘 되다가 쿼리가 실패합니다.** tunnel이 끊겼고 재연결이 포기한
것입니다. 오류 메시지에 bastion 이름이 담깁니다. bastion에 닿을 수 있게 되면
서버를 재시작하세요.

**서버가 즉시 종료됩니다.** wrapper를 직접 실행해 보세요. 시작 실패는
`ENABLE_LOGGING`과 무관하게 이유를 stderr에 찍습니다.

**쿼리가 `PROTOCOL_CONNECTION_LOST` 또는 `Connection lost`로 실패합니다.**
쿼리 도중 tunnel이 사라졌습니다. 기본 설정에서는 각 서버가 자기 tunnel을 소유하므로
bastion이나 네트워크를 의심하세요. `MYSQL_SSH_REUSE_EXISTING=true`를 켜 뒀다면,
공유 forward를 소유한 프로세스가 종료된 것이 훨씬 유력한 원인입니다 — flag를
다시 끄세요.

**`git push`가 "refusing to allow an OAuth App to create or update workflow"로
거부됩니다.** `workflow` scope가 없는 토큰으로 HTTPS remote를 쓰고 있습니다.
SSH remote를 쓰세요:

```bash
git remote set-url origin git@github.com:<owner>/<repo>.git
```

## 구성

```text
index.ts              MCP 서버, tool + resource handler, 종료 처리
src/config/           env 로딩, profile 정책, mysql2 옵션
src/catalog/          로컬 schema catalog, DB metadata 수집과 검색
src/db/               쿼리 routing, 권한 검사, pool
src/security/         PII redaction (원본 프로젝트)
src/ssh/config.ts     ~/.ssh/config Host alias parser
src/ssh/tunnel.ts     tunnel lifecycle: 열기, 재사용, 재연결, 닫기
bin/                  MCP 클라이언트용 profile wrapper
```

## 라이선스

MIT. [LICENSE.md](LICENSE.md)를 참고하세요.
