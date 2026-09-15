# 되돌린 결정

한 번 검토하거나 구현한 끝에 버린 설계를 남긴다. 같은 안이 다시 올라왔을 때 처음부터
논의하지 않기 위한 기록이다. 새로 무언가를 걷어내면 여기에 한 항목을 더한다.

형식: **무엇을** — 왜 버렸는지, 대신 무엇이 남았는지.

## 서버가 스스로 알아내게 하려던 것

- **앱↔스키마 매핑의 자동 도출.** `MYSQL_APP_SCHEMAS`를 없애고 서버가 요청마다
  갱신하도록 하자는 안이 있었으나 철회했다. 매핑은 env로 **수동 유지**한다. 틀린
  매핑은 모델을 조용히 잘못된 스키마로 보내는데, 자동 도출은 그 틀림을 눈에 띄지 않게
  만든다.
- **코드 브랜치 매핑.** 같은 이유로 `MYSQL_CODE_BRANCH`로 수동 유지한다. 브랜치를
  잘못 고르면 컬럼이 없는 것처럼 보일 뿐 오류가 나지 않는다.
- **문서↔테이블의 규칙 기반 자동 매칭.** 이름 일치와 컬럼 일치율로 Node가 스스로
  `model.md`를 테이블에 이어 주자는 설계를 검토한 끝에 버렸다. 판단은 모델이 catalog
  도구로 하고, 서버는 캐시가 비었을 때 **연결을 유도하는 안내**를 응답에 붙이는 데
  그친다.

## 결과를 가공하던 계층

- **PII redaction.** 계층째로 걷어냈다 (`refactor: drop the PII redaction layer`).
  가려진 값은 모델이 판단할 근거를 함께 지운다. 이 서버는 개인용이고 프로필이
  가리키는 데이터에 이미 접근 권한이 있는 사람이 쓴다.
- **타임아웃 보고서의 리터럴·플랜 마스킹.** `maskLiterals`/`maskPlan`을 함께 제거했다.
  조건절 값이 가려지면 왜 느린지 설명할 수 없다.

## 원본에서 물려받았으나 범위 밖인 것

- **원격 HTTP transport, eval harness, Docker packaging.** 이 서버는 로컬 MCP
  클라이언트에 stdio로 서비스할 뿐이다.
- **연결 문자열 parser와 읽히지 않던 서버 설정.**
  (`refactor: 읽히지 않는 서버 설정과 연결 문자열을 걷어낸다`) profile env 파일이 유일한
  설정 경로다.
- **쿼리 fingerprint 저장소.** 아무도 읽지 않는 상태를 유지하고 있었다
  (`refactor: drop the unread query fingerprint store`).
- **`MYSQL_LOG_LEVEL`.** 로깅은 `ENABLE_LOGGING` 하나로 켜고 끈다
  (`chore: drop MYSQL_LOG_LEVEL from the profile template`).
