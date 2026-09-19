# Oh My Aside 안내

Oh My Aside는 사용자가 skill 관리를 직접 하지 않도록 돕는 로컬 alpha 도구입니다. bootstrap을 지키는 Aside 세션이 검증된 재사용 절차를 짧은 redacted record로 제출하면, CLI가 자신이 관리하는 Markdown skill만 생성·갱신·보관합니다.

가장 중요한 한계는 명확합니다. 자동화는 설치된 bootstrap을 실제로 따르는 세션 안에서만 동작합니다. 일반 새 root chat의 전역 로딩은 검증되지 않았습니다. lifecycle 또는 finished 이벤트도 성공 증거가 아닙니다.

`--account-root`는 모든 변경 명령에 필수입니다. Aside에게 account root를 확인하게 하며 추측하지 마십시오. 원본 transcript, credential, incognito 기록, 임의 코드, provider DB는 입력으로 사용하지 않습니다. privacy 검사기는 단순 휴리스틱이며 DLP 보장이 아닙니다.

기본 흐름은 `install` → 검증된 record로 `learn` → preview 후 `maintain --apply`입니다. history backfill은 기본으로 꺼져 있고, 명시적 동의 후 선택/all eligible 기록을 최대 20개씩 정규화해서만 처리합니다. archive에는 purge가 없고, `restore`와 마지막 content update용 `rollback`이 있습니다.

생성 대상은 `oma-` prefix의 관리된 `SKILL.md` 하나뿐입니다. 사용자 skill, built-in, linked skill, 외부 경로는 수정하지 않습니다. 수동 편집 drift가 있으면 자동 update/archive/rollback을 중단합니다.
