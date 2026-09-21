# Hermes에서 가져올 것과 Aside에 맡길 것

기준: Hermes `3b7eda08878cf520d04a6085f1a32926ea018026`, Aside CLI `1.26.916.1741` 가이드와 로컬 built-in `skill-creator`, `visual-browse`, `aside` 스킬. Aside 비공개 내부 구현 전체를 조사한 것은 아니다.

목표는 코딩을 모르는 사용자가 반복 작업에서 검증한 방법을 재사용해 토큰을 덜 쓰는 것이다. 기존 Aside 기억 기능은 그대로 활용한다.

| 항목 | Aside와의 관계 | 이번 변경 / 판단 |
|---|---|---|
| MD와 스크립트 함께 저장 | 기본 skill-creator도 scripts/references/assets를 허용 | OMA 관리 패키지의 해시·백업·복구를 전체 파일로 확장 |
| 검증 절차와 pitfalls | MD에 업무 규칙 저장 가능 | 성공 조건 유지, 실패 시 MD로 복귀, 검증 후 같은 taskType 개선 |
| 단계적 복구 | visual-browse에 snapshot/locator 우선과 실패 후 새 화면 확인 규칙이 있음 | 기존 지침 재사용, 한 번의 MD 복구와 task별 스크립트 시도 제한 |
| 간결한 교훈 저장 | Aside 메모리와 원래 사용자 스킬이 존재 | 일반화한 절차와 최소 실행 기록만 보관; builtin/원본 직접 수정 안 함 |
| 필요한 것만 읽기 | 서비스별 REPL helper가 이미 있음 | built-in/user 스킬 먼저 검색, 메타데이터로 선택 후 해당 스크립트만 읽기 |
| 매 작업의 background 자기평가 | 추가 모델 호출 비용 발생 | 도입하지 않음; 재사용 가치나 실패가 있을 때만 개선 |
| 스케줄러·메모리·모델 계층 추가 | Aside 기본 기능과 중복 | 도입하지 않음 |

기존 Aside 실행 도구에 연결하므로 별도 Playwright MCP 설치나 Python 브라우저 실행기는 필요하지 않다. 현재 recipe transport는 Aside REPL이며, native tool과 외부 CLI가 같은 본문을 사용한다.

## 효과를 판단할 기준

검증된 완료율을 먼저 비교한다. 동일한 작업·입력 조건에서 실패와 복구를 포함한 완료당 토큰, 시간, 사용자 개입 횟수를 측정한다. provider 사용량을 얻지 못하면 미측정으로 남긴다. 몇 번의 성공으로 100% 신뢰성이나 절감률을 주장하지 않는다.

정상·빈 결과·화면 변경·로그인 만료·부분 완료를 포함한 읽기 작업으로 검증해야 한다. 명시적으로 스킬을 지정한 테스트는 일반 새 Aside 채팅에서 bootstrap이 자동 적용되는 증거가 아니다.

## 근거

- [Hermes skill 생성 가이드](https://github.com/NousResearch/hermes-agent/blob/3b7eda08878cf520d04a6085f1a32926ea018026/website/docs/developer-guide/creating-skills.md): 스킬 묶음과 도구의 역할.
- [Hermes Skills System](https://github.com/NousResearch/hermes-agent/blob/3b7eda08878cf520d04a6085f1a32926ea018026/website/docs/user-guide/features/skills.md): 절차형 스킬과 사실형 메모리, 리소스 로딩.
- [Hermes blocked-page-recovery](https://github.com/NousResearch/hermes-agent/blob/3b7eda08878cf520d04a6085f1a32926ea018026/skills/web/blocked-page-recovery/SKILL.md): 단계적 복구와 실제 성공 확인.
- [Hermes background review](https://github.com/NousResearch/hermes-agent/blob/3b7eda08878cf520d04a6085f1a32926ea018026/agent/background_review.py): 별도 리뷰와 제한된 자기개선.
- Aside 문서는 `aside guide`, `aside guide repl`과 `aside skills list`에 실제 나오는 스킬의 `aside skills show <name>`으로 확인한다. 이번 호스트에서는 `skill-creator`와 `visual-browse` 원본을 로컬 builtin 폴더에서 읽었지만 CLI 목록에는 없었으며, `show visual-browse`도 실패했다. 디스크에 있는 스킬과 현재 CLI가 노출하는 기능은 구분한다. 개인 자료나 기본 스킬 전문을 공개 저장소로 복사하지 않는다.
