# Stack & Sell — 아이템 오브젝트 풀링 최적화

> Unity 6 (6000.5.0f1) · URP · Android · `UnityEngine.Pool.ObjectPool<T>` · ProfilerRecorder · Profile Analyzer

> 근거 자료: 커밋 `0cf87cc` `61bda18` `e700edf` `3041917`, `Docs/Optimization/Android_csv/*.csv`(Android 10개),
> `Docs/Optimization/*.csv`(Editor 10개), `Docs/Optimization/*.png`(Profiler / Profile Analyzer 캡처)

---

## 1. 최적화 작업 개요

Stack & Sell은 플레이어가 생산 존에서 아이템을 수집해 등에 쌓고, 판매 존에서 하나씩 판매해 골드를 얻는 모바일 캐주얼 게임입니다.
이 작업은 수집·판매 루프에서 반복되던 `Instantiate` / `Destroy`를 오브젝트 풀링으로 교체하고,
그 효과를 **실제 게임 로직을 그대로 사용하는 자동화 벤치마크**로 측정·해석한 과정입니다.

| 항목 | 내용 |
|---|---|
| 대상 | `SSItemZone`의 아이템 생성·파괴 |
| 방식 | 생산 존별 `ObjectPool<SSItem>` |
| 검증 | 자동화 벤치마크(10사이클 × 5회), Android 실기기, Editor Profile Analyzer |
| 확인된 효과 | 반복 구간 사이클당 GC Alloc 2,720B → 2,280B (−16.2%), 할당 횟수 71.22 → 56.22회 (−21.1%) |
| 확인되지 않은 효과 | Main Thread / Frame Time 개선 (60fps 상한에서 차이 관측되지 않음) |

---

## 2. 기존 구조와 개선 필요성

### 아이템 흐름

```
[생산 존 진입] → ProduceItems 코루틴 (actionInterval 0.2초)
   → Instantiate(prefab) → SSPlayerCollector.Collect() → 스택 이동 코루틴 (0.15초)
[판매 존 진입] → SellItems 코루틴 (0.2초)
   → RemoveOneItem() → 골드 지급 → 판매 존 이동 코루틴 (0.15초) → Destroy()
```

### 기존 코드 (커밋 `61bda18` 기준)

```csharp
// ProduceItems
SSItem item = Instantiate(itemPrefab, transform.position, transform.rotation);
collector.Collect(item);

// MoveItemToZoneAndDestroy
Destroy(item.gameObject);
```

아이템 1개를 수집·판매할 때마다 GameObject 1개가 생성되고 1개가 파괴됩니다.
이 루프가 게임플레이의 핵심이므로, 생성·파괴는 플레이 시간에 비례해 계속 발생합니다.

### 예상한 비용 (측정 전 가설)

- `Instantiate`: 네이티브 오브젝트 생성, 컴포넌트 초기화, 관리 힙 래퍼 할당
- `Destroy`: 실제 파괴는 프레임 끝에 일어나고, 남은 관리 래퍼는 이후 GC 대상이 됨
- 모바일에서는 관리 힙 할당이 쌓이면 GC가 실행될 수 있고, 이는 프레임 스파이크의 원인이 될 수 있음

실제로 확인된 것과 확인되지 않은 것은 6~7장에서 구분합니다.

---

## 3. 오브젝트 풀링 설계 및 구현

### 3.1 `UnityEngine.Pool.ObjectPool<T>` 선택 이유

- Unity 2021부터 엔진에 포함된 API라서 별도 패키지나 직접 만든 풀이 필요 없음
- 생성 / 반환 / 파괴 콜백이 정해져 있어 코드가 짧음
- `collectionCheck: true`로 두면 에디터에서 같은 객체를 두 번 반환하는 실수를 바로 감지
- 프로젝트 규칙(Manager 클래스·과도한 추상화 지양)에 맞게, 전역 매니저 없이 존이 풀을 직접 소유

풀의 소유 구조(존별 풀 / MonoBehaviour 풀 관리자 / 전역 매니저 / 아이템 데이터 기반 조회)를 비교하고 결정한 과정은 4.2절에 정리했습니다.
풀 자료구조는 직접 구현하지 않고 `ObjectPool<SSItem>`을 사용했으며, Queue 기반 풀을 직접 구현하는 방안은 따로 비교하지 않았습니다.

### 3.2 `SSItemPool` — 프리팹 1개당 풀 1개, 생산 존이 소유

```csharp
// SSItemZone.Awake
if (!isSellZone && itemPrefab != null)
    itemPool = new SSItemPool(itemPrefab, transform, poolMaxSize, poolMaxSize);
```

- 판매 존은 아이템을 만들지 않으므로 생산 존에만 풀이 생성됨 (Main 씬에 생산 존 2개)
- `poolMaxSize = 10`: 코드 주석 기준 "기본 적재량 5 + 용량 업그레이드 5회"
- 비활성 아이템은 해당 생산 존 Transform 아래에 보관

`Get()`은 기존 `Instantiate(prefab, position, rotation)`과 **같은 상태**를 만든 뒤 마지막에 활성화합니다.

```csharp
public SSItem Get(Vector3 position, Quaternion rotation)
{
    SSItem item = pool.Get();
    Transform itemTransform = item.transform;
    itemTransform.SetParent(null);
    itemTransform.SetPositionAndRotation(position, rotation);
    itemTransform.localScale = prefab.transform.localScale;
    item.gameObject.SetActive(true);   // Transform 설정이 끝난 뒤 활성화
    return item;
}
```

`actionOnGet`을 쓰지 않은 이유: 위치를 정하기 전에 활성화되는 순서를 피하기 위해서입니다 (코드 주석 근거).

### 3.3 아이템이 원래 풀로 돌아가는 구조

판매 존은 아이템이 어느 생산 존에서 왔는지 알 필요가 없습니다. 아이템이 자신을 만든 풀을 기억합니다.

```csharp
// SSItemPool.CreateItem — 풀이 비었을 때만 호출됨
SSItem item = Object.Instantiate(prefab, poolRoot);
item.gameObject.SetActive(false);
item.SetPool(this);

// SSItem
public void ReturnToPool()
{
    if (pool != null) pool.Release(this);
    else Destroy(gameObject);      // 씬에 직접 배치한 아이템은 기존처럼 파괴
}
```

### 3.4 판매 애니메이션 완료 후 반환

```csharp
// SSItemZone.MoveItemToZoneAndRelease — 0.15초 이동이 끝난 뒤
item.ReturnToPool();

// SSItemPool.OnReleaseItem
item.gameObject.SetActive(false);              // 먼저 비활성화
item.transform.SetParent(poolRoot, false);
```

비활성화를 먼저 하기 때문에 벤치마크의 판매 완료 판정(`activeInHierarchy == false`)이
풀링 전 `Destroy`의 판정(`item == null`)과 기능적으로 같은 완료 상태를 가리킵니다.

다만 판정되는 프레임이 반드시 같지는 않습니다. `SetActive(false)`는 호출 즉시 반영되지만, `Destroy()`의 실제 파괴는 프레임 끝으로 미뤄집니다.
그래서 Before에서는 마지막 아이템의 완료가 After보다 늦은 프레임에 판정될 수 있습니다.
사이클 하나가 약 219프레임이므로 이 차이가 사이클 지표에 주는 영향은 작다고 보지만, 따로 측정하지는 않았습니다.

### 3.5 `SSPlayerCollector` 이동 코루틴 생명주기

풀링을 도입하면 생길 수 있는 **잠재적 상태 충돌**입니다.
실제 플레이 중 발생한 버그를 재현해 찾은 것이 아니라, 설계 단계에서 검토해 미리 막은 사례입니다 (검토 과정은 4.2절).

- 기존: 스택 이동 코루틴(`MoveItemToStack`)이 끝나기 전에 아이템이 판매·파괴되면 `item == null` 검사로 코루틴이 스스로 종료됨
- 풀링 후: 아이템이 **파괴되지 않고 재사용**되므로 `null`이 되지 않음. 끝나지 않은 이전 코루틴이
  판매 애니메이션이나 다음 수집 때의 이동과 같은 Transform을 동시에 움직일 수 있음

아이템별 이동 코루틴 핸들을 보관하고, 스택에서 빠질 때 정지시켰습니다.

```csharp
private readonly List<Coroutine> moveCoroutines = new();   // collectedItems와 같은 인덱스

// Collect
moveCoroutines.Add(StartCoroutine(MoveItemToStack(item, targetLocalPosition)));

// RemoveOneItem
Coroutine moveCoroutine = moveCoroutines[lastIndex];
if (moveCoroutine != null)
    StopCoroutine(moveCoroutine);    // 이미 끝난 코루틴이면 아무 일도 하지 않음
moveCoroutines.RemoveAt(lastIndex);
```

### 3.6 프리웜 0 (미리 생성하지 않음)

`ObjectPool`의 `defaultCapacity`(=10)는 내부 스택의 초기 용량일 뿐 오브젝트를 미리 만들지 않습니다.
별도의 프리웜 코드도 없으므로 실제 동작은 다음과 같습니다.

| 구간 | 동작 |
|---|---|
| 1사이클 (First) | 풀이 비어 있어 `PoolCreateItem`(내부 `Instantiate`) 5회 |
| 2사이클 이후 (Repeat) | 판매로 반환된 5개를 재사용, `PoolCreateItem` 0회 |

벤치마크도 First / Repeat를 따로 기록하므로 **최초 생성 비용과 재사용 비용을 분리해서 볼 수 있습니다.**

**의도적인 결정입니다.** Claude Code의 초기 설계안에는 프리웜 5개가 있었지만, 개발자가 측정 목적을 고려해 0으로 바꿨습니다.

- 프리웜을 하면 최초 생성 비용이 벤치마크 측정 전 초기화 단계로 옮겨질 수 있음
- 이번 실험의 목적은 최초 생성 비용과 재사용 비용을 분리해서 확인하는 것
- 따라서 첫 사이클에서 필요한 만큼 생성하고, 판매 후 반환된 객체를 이후 사이클에서 재사용하도록 함

이것은 이번 실험의 비교 가능성을 위한 선택입니다. 실제 서비스에서 프리웜이 필요 없다고 판단한 것은 아닙니다.

---

## 4. AI 활용 및 개발자 의사결정

ChatGPT는 문제 정의, 설계 조건 논의, 설계안 검토에 활용했습니다.
Claude Code는 프로젝트 코드 분석, 설계안 제안, 구현, 측정 데이터 정리에 활용했습니다.
요구사항과 제약 정의, 제안 채택 여부 판단, 실기기 측정 수행, 결과 해석의 최종 판단은 개발자가 했습니다.
Claude Code에는 개발자 승인 전에는 코드를 수정하지 않도록 지시하고, 설계안을 검토한 뒤 구현을 진행했습니다.

### 4.1 벤치마크 도구 (Claude Code 세션 기록으로 확인)

| 단계 | 개발자 | AI (Claude Code) |
|---|---|---|
| 요구사항 정의 | 자동화 흐름 7단계와 제약 8가지를 직접 정의: 기존 수집·판매 코루틴 사용, 테스트 코드에서 Instantiate/Destroy 직접 호출 금지, CharacterController 이동 고려, 업그레이드·세이브 변경 차단, 매 프레임 로그 금지, 실제 게임과 분리, 풀링 전후 같은 스크립트 사용 | 관련 스크립트 4개 분석 후 설계안과 변경 파일 제시 (코드 수정 전 단계) |
| 측정 방식 결정 | AI가 제안한 ProfilerRecorder + CSV 방식을 채택하고 12개 항목 보완 요청: First/Repeat 구분, GC Allocation Count를 GC 실행 횟수와 구분, 미지원 카운터는 N/A로 기록, 프레임 중복·누락 방지, 각 지표의 측정 범위 설명 | ProfilerRecorder 기반 측정 및 CSV 저장 구현 |
| 검증 | Editor에서 10사이클 동작과 골드 복원 확인, Android 측정 지원 및 CSV 저장 경로 변경 요청 | Android 대응, 저장 경로 분기 구현 |

### 4.2 오브젝트 풀링 설계 및 구현

**진행 순서**

1. 개발자 + ChatGPT: 기존 구조의 문제점, `ObjectPool<T>` 사용 방식, 설계 시 고려할 조건(코루틴 충돌 가능성 포함)을 정리
2. Claude Code: 현재 프로젝트 코드를 분석하고 설계안 제안 (승인 전 코드 수정 금지)
3. 개발자: 설계안 검토 및 방향 결정 → ChatGPT로 재검토 → Claude Code에 수정 요청
4. Claude Code: 승인된 설계로 구현

**풀 소유 구조**

| Claude Code가 제안한 대안 | 결과 |
|---|---|
| 생산 존마다 독립적인 일반 C# 풀을 소유 | **채택** |
| 풀 관리 클래스를 MonoBehaviour로 구현 | 미채택 |
| 전역 풀 매니저 사용 | 미채택 |
| 아이템 데이터를 기준으로 풀 조회 | 미채택 |

개발자의 판단 근거:
- `SSItemZone`이 이미 각 아이템 프리팹을 관리하고 있으므로, 존별 풀이면 전역 매니저나 별도 딕셔너리 없이 기존 구조를 그대로 활용할 수 있음
- `SSItem`이 원래 풀을 참조하게 하면, 판매 존이 아이템 종류를 판단하지 않아도 원래 풀로 반환할 수 있음
- 풀 자료구조는 `UnityEngine.Pool.ObjectPool<SSItem>`을 사용 (Queue 기반 직접 구현은 비교 대상이 아니었음)

**코루틴 충돌 검토 (설계 단계의 예방, 실제 버그 재현 아님)**

| 단계 | 주체 | 내용 |
|---|---|---|
| 문제 인식 | 개발자 + ChatGPT | 초기 설계 요구사항 작성 시점부터, 재사용 객체에 이전 이동 코루틴이 남을 가능성을 고려 |
| 1차 제안 | Claude Code | 코루틴 안에서 아이템의 부모 Transform을 검사해 이동을 중단하는 방식 |
| 검토 | 개발자 + ChatGPT | 같은 객체가 재사용되어 **다시 같은 `stackRoot`에 붙으면 부모 검사를 통과**하므로 충돌을 막지 못한다는 점을 지적 |
| 2차 제안 | Claude Code | 재검토 요청을 받아, `RemoveOneItem` 시점에 해당 아이템의 이동 코루틴을 `StopCoroutine`으로 중지하는 방식 제안 |
| 결정 | 개발자 | 2차 제안을 검토한 뒤 채택 (3.5절 코드) |

**프리웜 정책**

| 주체 | 내용 |
|---|---|
| Claude Code | 초기 설계안에서 프리웜 5개 제안 |
| 개발자 | 최초 생성 비용과 재사용 비용을 나눠 측정하기 위해 0으로 변경 (3.6절) |

### 4.3 결과 분석 단계

- Claude Code: 원본 CSV 20개(Android 10, Editor 10)로 First/Repeat 통계를 다시 계산, Editor 데이터의 한계와 마커 측정 범위 차이를 정리
- 개발자: 실기기 측정 수행, FPS 개선을 주장하지 않는다는 판단, 문서 범위 결정

---

## 5. 벤치마크 환경 및 자동화 구현

### 5.1 실제 게임 시스템을 그대로 사용

`Benchmark.unity`가 `Main` 씬을 Additive로 불러오고, `SSBenchmarkRunner`가 **입력만 대신합니다.**

- `SSPlayerController`를 끄고 `CharacterController.Move()`로 고정 속도(5m/s) 이동 → 존 트리거가 실제 게임과 동일하게 동작
- 생성·판매는 `SSItemZone`의 기존 코루틴이 처리. 러너는 Instantiate / Get / Release를 직접 호출하지 않음
- 세이브 시스템과 업그레이드를 끄고 적재량을 5로 고정, 종료 후 골드·용량 복원
- `#if UNITY_EDITOR || DEVELOPMENT_BUILD`로 감싸 릴리스 빌드에서 제외
- 풀링 전후 모두 같은 러너를 사용하고, `label` 필드(Instantiate / Pool)로만 구분

### 5.2 사이클 정의

```
MoveToCollect → Collect(적재 5개까지 대기) → MoveToSell → Sell(골드 일치 + 5개 모두 비활성/파괴까지 대기)
```

- 1사이클 = 5개 수집 → 5개 판매. 1회 실행 = 10사이클. Before / After 각 5회 실행
- 단계별 제한 시간(이동 15초, 수집·판매 10초)을 넘기면 실패 단계를 기록하고 남은 사이클 중단
- `Phase` 열: 1사이클 = `First`(풀 최초 생성 포함), 2~10사이클 = `Repeat`

### 5.3 측정 지표 (ProfilerRecorder)

| CSV 열 | 출처 | 의미 |
|---|---|---|
| MainThread{Median,P95,Max}Ms | `Internal / Main Thread` | 프레임별 메인 스레드 시간 |
| FrameTime{Median,P95,Max}Ms | `Time.unscaledDeltaTime` | 실제 프레임 간격 (VSync·대기 포함) |
| GCAllocBytes | `GC Allocated In Frame`의 사이클 합 | 사이클 동안 관리 힙에 할당된 바이트 |
| GCAllocCount | `GC Allocation In Frame Count`의 사이클 합 | 관리 힙 **할당 이벤트 횟수** (GC 수집 실행 횟수가 아님) |
| GCUsedMB / GCReservedMB | `GC Used / Reserved Memory` | 사이클 종료 시점의 관리 힙 사용량 / 예약량 |

- 측정 중에는 미리 만든 배열과 `long` 누적값에만 기록해 러너 자체의 할당을 막음
- `Update`에서 읽는 `LastValue`는 직전 프레임 값 → 완료 프레임까지 포함되도록 1프레임 더 대기, 기록 수를 검증(`SamplingValid`)
- P95는 nearest-rank 방식

### 5.4 Editor 측정의 한계 → 실기기 측정으로 전환

같은 러너로 Editor에서 측정한 결과 (Repeat 45사이클 평균):

| | Instantiate | Pool |
|---|---:|---:|
| GC Alloc / 사이클 | 15,861,261 B | 16,403,494 B |
| GC Allocation Count / 사이클 | 385,911 | 406,542 |
| Main Thread 중앙값 (사이클 중앙값의 중앙값) | 2.189 ms | 1.949 ms |

사이클당 약 16MB는 아이템 5개로 설명할 수 없는 규모입니다. Editor 자체의 할당이 함께 기록된 것으로 보이며, 이 수준에서는 풀링 효과를 구분할 수 없었습니다.
Main Thread 차이도 두 측정의 Editor 상태 차이(Pool 쪽 사이클 최대값이 약 35ms로 더 큼)가 섞여 있어 결론에 쓰지 않았습니다.
그래서 측정을 둘로 나눴습니다.

- **Android 실기기 CSV**: 사이클 단위 실제 할당량과 프레임 시간
- **Editor Profile Analyzer**: 생성·반환 마커 단위 비용

### 5.5 Android 측정 조건

| 항목 | 값 | 근거 |
|---|---|---|
| 기기 | Samsung Galaxy S25+ (SM-S936N) | Unity Build Profiles의 기기 모델 번호 |
| Unity | 6000.5.0f1 | `ProjectSettings/ProjectVersion.txt` |
| 빌드 | Development Build | Android Build Profile `m_Development: 1` |
| 스크립팅 / 아키텍처 | IL2CPP / ARM64 | `scriptingBackend Android: 1`, `AndroidTargetArchitectures: 2` |
| 프레임 상한 | `Application.targetFrameRate = 60` | `SSBenchmarkRunner.Awake` (`UNITY_ANDROID && !UNITY_EDITOR`) |
| 반복 | Before / After 각 10사이클 × 5회 | CSV 10개, 100사이클 전부 `Success=true`, `SamplingValid=true` |
| 측정 시각 | Pool 2026-10-18 04:05~04:11, Instantiate 04:32~04:39 | CSV Run ID |

### 5.6 Before / After 빌드 구성

Before 버전은 `git checkout`으로 되돌리지 않고 **Git Worktree**로 별도 디렉터리에 만들었습니다.

```
git worktree add -b BeforeBenchmark ../StackSell_Before e700edf
```

| 디렉터리 | 브랜치 | 내용 |
|---|---|---|
| `C:\Git\StackSell` | `ObjectPool` | 풀링 적용 버전 (After) |
| `C:\Git\StackSell_Before` | `BeforeBenchmark` (`e700edf` 기반) | 풀링 적용 이전 버전 (Before) |

- `e700edf`에는 자동화 벤치마크가 이미 들어 있으므로, 풀링 전 코드에서 같은 벤치마크를 실행할 수 있음
- 두 프로젝트의 `SSBenchmarkRunner.cs`에 Android용 `Application.targetFrameRate = 60`을 똑같이 추가
- 둘 다 Android Development Build / IL2CPP / ARM64로 빌드해 같은 기기에서 측정
- 측정 순서: Pool(After) 먼저, Before 나중

---

## 6. Before / After 성능 비교 (Android 실기기)

### 6.1 Repeat 구간 (각 실행의 2~10사이클, 각 45사이클)

| 지표 | Before (Instantiate) | After (Pool) | 차이 |
|---|---:|---:|---:|
| GC Alloc / 사이클 (평균) | 2,719.8 B | 2,279.8 B | −440 B (−16.2%) |
| GC Allocation Count / 사이클 (평균) | 71.22 회 | 56.22 회 | −15 회 (−21.1%) |
| Main Thread 중앙값 (45사이클 중앙값) | 16.673 ms | 16.674 ms | 차이 없음 |
| Main Thread P95 (중앙값) | 17.242 ms | 17.236 ms | 차이 없음 |
| Frame Time 중앙값 | 16.686 ms | 16.686 ms | 차이 없음 |
| Frame Time P95 (중앙값) | 16.700 ms | 16.701 ms | 차이 없음 |
| 사이클당 프레임 수 (평균) | 219.4 | 219.5 | 차이 없음 |

할당 값은 매우 결정적으로 나왔습니다.

| 사이클 | Before | After |
|---|---:|---:|
| 2사이클 (5회 모두 동일) | 3,054 B / 73회 | 2,614 B / 58회 |
| 3~10사이클 (40사이클 모두 동일) | 2,678 B / 71회 | 2,238 B / 56회 |

사이클당 아이템 5개를 처리하므로, 관측된 감소량(440B / 15회)은 **아이템 1개당 평균 88B, 할당 이벤트 3회**에 해당합니다.
다만 이번 변경에는 풀링과 함께 `SSPlayerCollector`의 코루틴 관리 코드 변경도 들어 있으므로, 이 차이가 전부 Instantiate 제거에서 나왔다고 단정할 수는 없습니다.

### 6.2 First 구간 (1사이클, 각 5회)

| 지표 | Before | After |
|---|---:|---:|
| GC Alloc | 44,245 B | 44,548 B |
| GC Allocation Count | 938.2 회 | 943 회 |
| Main Thread 최대값 (중앙값) | 171.97 ms | 174.49 ms |

First 사이클은 두 조건 모두 약 44KB / 940회의 할당과 150~180ms 스파이크를 보입니다.
풀링 후에도 첫 사이클에서 아이템 5개를 새로 만들기 때문에 생성 비용이 사라지지 않았고, 할당은 오히려 약 300B / 5회 많습니다.

### 6.3 Editor Profile Analyzer (마커 단위)

Unity Profiler로 기록한 약 2,000프레임 구간을 Profile Analyzer로 불러와, 대상 마커가 포함된 구간을 분석했습니다 (Before / After 각 5회).

- Before: `StackSell.InstantiateItem`이 5회 기록된 구간
- After: 최초 생성이 끝나고 객체가 반환된 뒤의 재사용 구간. 각 측정마다 다음 조건을 확인
  - `PoolGetItem` 5회, `PoolReleaseItem` 5회
  - `PoolCreateItem`이 선택 구간에서 검출되지 않음

그래서 After 데이터는 신규 생성이 아니라 기존 객체를 재사용하는 비용으로 분류했습니다.
캡처마다 몇 번째 벤치마크 사이클이 포함됐는지는 기록하지 않았기 때문에, 사이클 번호는 표기하지 않습니다.

| 마커 | 중앙값 | GC Alloc |
|---|---:|---:|
| `StackSell.InstantiateItem` (Before) | 0.09 ms | 56 B |
| `StackSell.PoolGetItem` (After, 재사용 구간) | 0.04 ms | 0 B |
| `StackSell.PoolReleaseItem` (After) | 0.03 ms | 0 B |
| `StackSell.PoolCreateItem` (After, 재사용 구간) | 호출 0회 ("not in selection") | — |

**측정 범위가 서로 다릅니다.**
- `InstantiateItem`은 `Instantiate(prefab, pos, rot)` 호출 하나만 감쌈
- `PoolGetItem`은 `pool.Get()` + `SetParent(null)` + 위치·회전·스케일 설정 + `SetActive(true)`를 감쌈

그래서 0.09ms → 0.04ms는 "같은 작업이 빨라졌다"가 아니라 "사용 가능한 아이템을 내놓기까지의 비용"을 비교한 값입니다.
또한 `Destroy()`는 실제 파괴가 프레임 끝으로 미뤄지므로, 기존 `DestroyItem` 마커(0.01ms, Profiler 캡처)와 `PoolReleaseItem`은 직접 비교하지 않았습니다.

---

## 7. 측정 결과의 한계 및 해석

### 측정으로 확인된 사실

- Android 반복 구간에서 사이클당 GC Alloc 440B, 할당 이벤트 15회 감소 (45사이클 모두 같은 값)
- Editor 재사용 구간에서 `PoolCreateItem` 호출 0회, `PoolGetItem` / `PoolReleaseItem` GC 0B
- 60fps 상한에서 Main Thread·Frame Time의 중앙값과 P95에 의미 있는 차이 없음
- First 사이클의 할당과 스파이크는 풀링 후에도 남아 있음
- 측정 기간 동안 GC Reserved Memory는 약 4.35MB로 그대로였고, 사이클 종료 시점에 기록한 GC Used Memory는 모든 실행에서 이전 사이클보다 줄어든 적이 없음

### 합리적 해석

- **시간 지표에 차이가 없는 이유**: Frame Time이 16.686ms(60fps)에 고정되어 있고 Main Thread에도 대기 시간이 포함된 것으로 보입니다. 아이템 처리 비용(Editor 기준 0.1ms 미만)의 변화가 작거나 60FPS 제한 및 프레임 대기 시간의 영향으로 인해 전체 프레임 시간에서 차이가 드러나지 않았을 가능성이 있습니다.
- **GC 수집 여부**: 측정 구간에서 GC Used Memory의 뚜렷한 감소는 관측되지 않았습니다. 하지만 GC가 메모리를 회수하더라도 같은 구간의 다른 할당 때문에 순사용량은 늘어날 수 있습니다. GC 실행 횟수와 소요 시간은 따로 수집하지 않았으므로, 실제 GC가 수행됐는지와 GC로 인한 프레임 지연이 개선됐는지는 판단할 수 없습니다.
- **풀링 후에도 남는 사이클당 2,238B**: 풀링과 상관없는 경로로 보입니다. 코드상 후보는 생산·판매 루프의 `new WaitForSeconds`, `StartCoroutine`으로 만드는 이동 코루틴 객체, 러너의 `RunCycle` / `MoveTo` / `WaitUntilOrTimeout` 이터레이터이며, Before/After 모두 같게 존재합니다.
- **2사이클의 +376B / +2회**: Before/After에서 증가량이 똑같으므로 풀링과 관계없는 일회성 할당으로 봅니다.
- **First 사이클 150~180ms 스파이크**: 두 조건에서 비슷하므로 풀링과 관계없는 최초 실행 비용으로 봅니다.

### 확인되지 않은 가설

- 감소한 아이템당 평균 88B / 3회가 어느 호출에서 사라졌는지. Instantiate 제거와 코루틴 관리 코드 변경이 각각 얼마나 기여했는지는 나눠서 측정하지 않았음 (Editor `InstantiateItem` 마커의 56B는 Mono 기준이라 IL2CPP 실기기와 값이 다를 수 있음)
- First 사이클에서 Pool 쪽 할당이 약 300B / 5회 많은 원인
- 장시간 플레이에서 GC 수집 빈도나 GC로 인한 프레임 스파이크가 줄어드는지
- 60fps 상한을 풀었을 때나 저사양 기기에서 시간 지표 차이가 나타나는지

### 측정 한계

- Development Build 측정이므로 릴리스 빌드와 절대값이 다를 수 있음
- 기기 1대, 아이템 1종(AppleZone), 적재량 5 고정 시나리오
- 마커 단위 측정은 Editor에서만 수행
- Before / After는 별도 빌드(Git Worktree)로, 같은 날 순서대로 측정 (After 04:05~04:11 → Before 04:32~04:39). 기기 온도 등 측정 시점 차이의 영향은 따로 통제하지 않음
- Profile Analyzer 캡처에 포함된 사이클 번호는 기록하지 않음

### 하지 않는 주장

- 전체 게임 FPS 개선
- GC 수집 횟수 감소 (GC Allocation Count는 할당 이벤트 횟수이며 GC 실행 횟수가 아님)

---

## 8. 최종 결론 및 배운 점

- 엔진 내장 `ObjectPool<T>`과 짧은 코드 변경으로 반복 생성·파괴를 재사용 구조로 바꿨습니다. 실기기 반복 구간에서 사이클당 관리 힙 할당이 16.2%, 할당 횟수가 21.1% 줄었고, 재사용 구간의 생성 호출이 사라진 것을 확인했습니다.
- 풀링은 객체 수명을 바꿉니다. `null` 검사에 기대던 코루틴 종료가 재사용 객체에서는 작동하지 않을 수 있다는 점을 설계 단계에서 검토했습니다. AI의 첫 제안(부모 Transform 검사)이 재사용 상황에서 통하지 않는다는 점을 확인한 뒤, 코루틴 핸들을 직접 관리하는 방식을 채택했습니다.
- AI 제안을 그대로 쓰지 않고 측정 목적에 맞게 조정했습니다. 프리웜 5개 제안을 0으로 바꿔 최초 생성 비용과 재사용 비용을 분리해서 측정했습니다.
- 측정 도구의 설계가 결과의 신뢰도를 좌우했습니다. 실제 게임 루프를 쓰는 자동화, First/Repeat 분리, 미지원 카운터 N/A 처리, 프레임 기록 수 검증 덕분에 45사이클이 같은 값으로 재현되는 결과를 얻었습니다.
- Editor 측정값만으로는 결론을 낼 수 없었고, 실기기 측정과 마커 단위 분석을 함께 써야 했습니다.
- 60fps 상한에서는 시간 지표가 개선을 보여주지 않았습니다. 측정된 범위를 넘어서는 주장을 하지 않는 것도 결과 해석의 일부라고 판단했습니다.

---

## 포트폴리오 요약 (3~5문장)

Stack & Sell의 아이템 수집·판매 루프에서 반복되던 Instantiate/Destroy를 `UnityEngine.Pool.ObjectPool<T>` 기반의 생산 존별 풀로 교체하고, 객체 재사용 시 생길 수 있는 이동 코루틴 충돌을 설계 단계에서 검토해 코루틴 핸들 관리로 예방했습니다.
효과를 검증하기 위해 실제 게임 로직을 그대로 사용하는 자동화 벤치마크(10사이클 × 5회, First/Repeat 분리)를 Claude Code와 함께 설계·구현했습니다.
Galaxy S25+ 실기기(IL2CPP/ARM64) 측정에서 반복 구간의 사이클당 GC 할당이 2,720B에서 2,280B로(−16%), 할당 횟수가 71회에서 56회로(−21%) 줄었습니다.
60fps 상한에서는 프레임 시간 차이가 관측되지 않아 FPS 개선은 주장하지 않았고, 측정 범위와 한계를 함께 문서화했습니다.
