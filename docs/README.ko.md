# Oh My Aside 안내

Oh My Aside는 사용자가 코드를 고치거나 skill 관리를 직접 하지 않고도, 반복 작업에서 검증된 방법을 다시 쓰도록 돕는 로컬 alpha 도구입니다. bootstrap을 지키는 Aside 세션이 검증한 절차와 선택적 JavaScript를 제출하면, CLI가 자신의 관리 패키지만 생성·갱신·보관합니다.

가장 중요한 한계는 명확합니다. 자동화는 설치된 bootstrap을 실제로 따르는 세션 안에서만 동작합니다. 일반 새 root chat의 전역 로딩은 검증되지 않았습니다. lifecycle 또는 finished 이벤트도 성공 증거가 아닙니다.

`--account-root`는 모든 변경 명령에 필수입니다. Aside에게 account root를 확인하게 하며 추측하지 마십시오. 원본 transcript, credential, incognito 기록, 신뢰할 수 없는 코드, provider DB는 입력으로 사용하지 않습니다. privacy 검사는 휴리스틱이며 DLP 보장이 아닙니다.

기본 흐름은 `install` → 검증된 record로 `learn` → preview 후 `maintain --apply`입니다. history backfill은 기본으로 꺼져 있고, 명시적 동의 후 선택/all eligible 기록을 최대 20개씩 정규화해서만 처리합니다. archive에는 purge가 없고, `restore`와 마지막 content update용 `rollback`이 있습니다.

생성 대상은 `oma-` prefix의 `SKILL.md`와 선택적 `execution.json`, `scripts/<route>.js`입니다. 전체 묶음을 함께 해시 확인·백업·복구합니다. 사용자 원본 skill, built-in, linked skill, Aside 메모리는 수정하지 않습니다. 수동 편집이 있으면 자동 update/archive/rollback을 중단합니다.

반복 작업은 검증한 스크립트를 먼저 실행하고, 실패하면 기존 MD를 참고해 한 번 복구합니다. 결과를 확인한 뒤 같은 스킬을 개선합니다. 현재 버전과 실행 조건이 맞고 최근 두 번 검증에 성공한 경로만 자동 선택하며, 신뢰성 다음에 실제 측정한 토큰 비용을 비교합니다. 미측정 토큰을 0으로 표시하지 않습니다.

Aside 내부에서는 native JavaScript 도구와 `begin`/`record`를 사용합니다. 외부 코디네이터는 `run`으로 기존 Aside CLI를 호출할 수 있습니다. 내부에서 CLI를 다시 띄우는 인증 문제를 피하며, 별도 Playwright MCP나 메모리 시스템을 설치하지 않습니다. 자동 스크립트는 승인된 읽기 작업에만 사용하며, 결과가 불명확하면 재실행 전에 상태를 확인합니다.

[실행 계약](../skill/references/execution.md) · [Hermes 비교 검토](HERMES-REVIEW.ko.md)
