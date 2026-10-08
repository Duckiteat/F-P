# 맥락 보존형 정의 데이터베이스

옵시디언·노션처럼 "메모 한 장 = 노드"가 아니라, **정의항 하나 = 노드**인 개념 데이터베이스.
입력은 AI가 하고, 사람은 보고 검사만 한다.

## 왜 정의항끼리 잇는가

메모 링크는 `[[효소]]`처럼 *말*을 가리킬 뿐, 그 말의 **어느 뜻**인지는 잃어버린다.
여기서는 연결이 정의항 ID 끼리 걸린다.

```
효소#1  "생체 내 화학 반응의 촉매 역할을 하는 단백질"   〈고등학교 생명과학 (좁은 뜻)〉
  ↑ 상위 범주: 단백질#1, 촉매#1
  ↓ 하위 범주: 아밀레이스#1
효소#2  "생체 내 화학 반응을 촉매하는 생체 고분자 전반"  〈생화학 (넓은 뜻)〉
  ↑ 상위 범주: 촉매#1
  ↓ 하위 범주: 리보자임#1        ← 리보자임은 효소#2 아래에만 있고 효소#1 아래에는 없다
```

그래서 어떤 정의항에서 위로 올라가면 **그 뜻이 기대고 있는 정의들의 사슬**(맥락)이 그대로 나온다.

## 구조

| 단위 | 뜻 | 필드 |
|---|---|---|
| 피정의항 (term) | 정의되는 말 | `aliases`, `note`, `definientia[]` |
| 정의항 (definiens) | 정의 하나 | `id`(`피정의항#번호`), `text`, `context`(분야/관점), `links[]`, `examples[]`, `source`, `by`, `at` |
| 연결 (link) | 정의항 → 정의항 | `to`(정의항 id), `rel`, `span`(정의 문장 속 근거 구절), `note` |

관계(`rel`):

- 위계 — `is_a`/`has_kind` (상위·하위 범주), `part_of`/`has_part` (전체·구성요소), `instance_of`/`has_instance` (유형·사례)
- 비위계 — `requires` (조건/전제), `contrasts` (대비), `refers` (정의에 사용)

하위 방향은 저장하지 않아도 자동으로 계산된다(B가 A의 `is_a`이면 A의 화면에 B가 하위로 보임).
위계 순환은 오류로 막힌다. 대상 말의 뜻을 정하지 않은 연결(`"to": "효소"`)은 정의항이 하나뿐이면 자동으로 정해지고, 여러 개면 경고가 뜬다.

## 사용법

### 화면 (`viewer.html`)

`viewer.html` 과 `core.js` 를 같은 폴더에 두고 브라우저로 연다.

1. **AI 지침** → 정리할 자료를 넣고 복사 → 아무 AI(Claude, ChatGPT 등)에게 붙여 넣기.
   지침에는 현재 데이터베이스의 정의항 색인이 들어가므로 AI가 기존 뜻에 연결한다.
2. AI가 준 JSON을 **AI 결과 반영**에 붙여 넣기 → 추가/수정 목록과 새로 생긴 오류·경고를 확인 → 반영.
   오류가 있으면 반영되지 않는다. 메시지를 AI에게 돌려주면 된다.
3. 각 정의항의 **맥락 텍스트**를 복사하면 그 정의의 상위 사슬을 AI 대화에 그대로 넘길 수 있다.
4. **저장**으로 `definition-db.json` 을 내려받는다(브라우저에도 자동 보관됨). **불러오기**는 DB, 패치, 이전 bionote v3 파일을 모두 받는다.

### 명령줄 (`dbtool.mjs`, Node 18+) — AI 에이전트용

```sh
node dbtool.mjs prompt   db.json [자료.txt]          # 작성 지침 + 현재 색인
node dbtool.mjs merge    db.json patch.json [--dry]  # 검사 후 병합 (오류 있으면 저장 안 함)
node dbtool.mjs context  db.json 효소 [--up 4 --down 1]
node dbtool.mjs validate db.json
node dbtool.mjs migrate  bionote_v3_묶음.json > patch.json
```

## 패치 형식 (AI 출력)

```json
{
  "format": "definition-db-patch",
  "version": 1,
  "terms": {
    "리보자임": {
      "aliases": ["ribozyme"],
      "definientia": [{
        "id": "리보자임#+1",
        "text": "촉매 활성을 가진 RNA 분자",
        "context": "분자생물학",
        "links": [
          { "to": "효소#2", "rel": "is_a", "span": "촉매 활성", "note": "넓은 뜻의 효소에만 속함" },
          { "to": "RNA#1",  "rel": "is_a", "span": "RNA" }
        ],
        "by": "Claude", "at": "2026-10-08"
      }]
    }
  },
  "remove": []
}
```

- 새 정의항은 `피정의항#+1` 같은 임시 id → 병합 때 다음 번호로 바뀌고, 같은 패치 안의 연결도 함께 바뀐다.
- 기존 id 를 쓰면 그 정의항이 통째로 교체된다. `remove` 의 정의항은 삭제되고 그것을 가리키던 연결도 정리된다.

예시는 [`examples/sample-patch.json`](examples/sample-patch.json) → 병합 결과 [`examples/db.json`](examples/db.json).

## 이전 bionote v3 에서 옮기기

v3 의 개념(피정의항·정의항·예시항·공리항)은 그대로 변환된다. 역할은
상위범주→`is_a`, 구성요소→`has_part`, 조건→`requires`, 대비→`contrasts`, 기능·미정→`refers` 로 바뀌고 공리항은 피정의항 `note` 로 들어간다.
v3 에는 "어느 뜻"과 "맥락" 정보가 없으므로 변환 후 경고가 뜬다. 지침과 함께 AI에게 보완을 맡기면 된다.
반응·시간축 탭은 아직 옮기지 않았다.
