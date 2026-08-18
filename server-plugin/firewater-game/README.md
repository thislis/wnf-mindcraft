# FirewaterGame

Paper 1.21.6용 서버 권위 Fire and Water 협동 스테이지 플러그인이다. 커맨드 블록 없이 벽, 역할별 액체, 독, attempt 리셋, 역할별 출구를 처리한다.

## 빌드

Gradle Wrapper가 Java 21 toolchain을 자동 해석한다. Gradle 자체는 Java 17 이상으로 실행할 수 있다.

```powershell
./gradlew.bat clean test jar
```

결과 JAR은 `build/libs/firewater-game-0.1.0.jar`이다. 실행 중인 서버에 JAR을 덮어쓰거나 `/reload`로 Java 플러그인을 교체하지 말고, 서버를 정상 종료한 뒤 배포한다.

## 빠른 설정 순서

1. `config.yml`에서 Wade/Ember의 실제 Minecraft 이름을 확인한다.
2. `/fw stage create <id>`로 비활성 스테이지를 만든다.
   - 빠른 검증용 맵은 빈 공간 옆에 서서 `/fw stage create-reference <id>`로 생성할 수 있다. 시작 패널은 play bounds 밖에 배치되고 두 벽 상태, pad/lever/button, 물/용암/독, 역할별 출구가 포함된다.
3. `/fw wand`의 좌/우 클릭으로 영역을 잡고 `/fw stage setbounds <id>`를 실행한다.
4. 각 시작 위치에서 `/fw stage setspawn <id> wade|ember`를 실행한다.
5. 버튼/레버와 출구 블록을 바라보며 `setstart`, `setfinish`를 실행한다.
6. 벽 영역을 선택하고 `/fw wall save <stage> <wall-id> true|false`를 실행한다.
7. 발판/레버/버튼을 바라보며 `/fw trigger add <stage> <wall-id> <pad|lever|button>`을 실행한다.
8. `setgoal`, `setbrief`, `validate`, `enable true` 순서로 마무리한다.
9. 시작 장치를 누르거나 `/fw stage start <id>`를 실행한다.

편집 명령에는 `/fw stage delete|sethold|setpoison`, `/fw wall delete|preview|restore`, `/fw trigger remove`도 포함된다. wall은 그룹당 1,024개, stage 전체 4,096개 블록으로 제한된다.

전체 명령은 `/fw help`에서 볼 수 있다. 생성되는 YAML 스키마는 `src/main/resources/stages/example.yml`을 참고한다.

## 규칙

- 벽은 `defaultVisible XOR anyBoundTriggerActive`다. 같은 그룹의 입력 둘이 동시에 켜져도 한 번만 반전된다.
- 시작 장치는 button/lever만 허용하며 play bounds 밖의 운영 패널에 둘 수 있다. wall trigger에는 pad/lever/button을 사용할 수 있다.
- wall은 정적·비중력·비대화형 BlockData만 허용한다. tile entity, waterlogged 블록, 유체와 맞닿은 wall은 거부하며 등록 wall 칸으로 유체가 흐르는 이벤트도 차단한다.
- Wade는 물에 안전하고 용암에 실패한다. Ember는 용암에 안전하고 물에 실패한다. 독은 둘 모두 실패한다.
- 위험 판정은 활성 스테이지 bounds 안에서만 동작한다. 물, 거품 기둥, 실제로 waterlogged 된 블록도 물 접촉으로 본다.
- 독은 기본적으로 `lime_carpet`, `green_stained_glass`, `green_concrete` 접촉이다.
- 한 명이 죽으면 실제 사망/리스폰 이벤트 후 두 명 모두 다음 attempt의 시작점으로 돌아간다.
- Wade와 Ember가 자기 출구를 동시에 10 tick 유지할 때만 클리어된다.
- 출구 좌표는 플레이어가 올라서는 단단한 표식 블록이다. 출구와 그 위 두 칸은 액체/독이 아니어야 하고, 위 두 칸은 통과 가능하며 모두 play bounds와 월드 높이 안에 있어야 stage가 시작된다.
- Wade/Ember는 전용 게임 계정이다. 플러그인이 켜진 동안 항상 non-OP, Adventure, 빈 인벤토리를 유지하며 stage 밖에서는 역할 포션도 제거한다.
- 플레이어 hitbox가 play bounds 또는 stage world를 벗어나면 해당 attempt가 실패한다. 실행 중 stage 영역은 외부 플레이어의 변경과 참가자의 등록되지 않은 상호작용으로부터 보호된다.
- stage 시작 전에 `plugins/FirewaterGame/active-session.yml`을 원자적으로 기록한다. 강제 종료 후 다음 enable에서 wall/trigger default를 UUID가 일치하는 world에 복구한 뒤 새 session을 허용한다.

서버 메시지는 다음 prefix를 전송한다: `[FWG:START]`, `[FWG:RESET]`, `[FWG:CLEAR]`, `[FWG:ABORT]`. START에는 봇 명령 검증용 `world`, `min-x/min-y/min-z`, `max-x/max-y/max-z`가 포함된다. 짧은 메시지는 `minecraft:tell`, 240자를 넘는 START는 같은 vanilla incoming-whisper translation key를 쓰는 Adventure Component로 전달한다. 두 방식 모두 Mineflayer의 `whisper`/`messagestr` 경로에서 검증됐다.

저장소 루트의 `npm run smoke:firewater`는 임시 Paper 1.21.6 서버와 두 raw Mineflayer 클라이언트를 띄워 물/용암/독, 사망·리스폰, attempt reset, 양쪽 출구, FWG 메시지를 실제 프로토콜로 검증한 뒤 임시 서버를 삭제한다. 이 스모크는 콘솔 teleport/setblock을 사용하므로 Mindcraft·Codex 자율 클리어 증거는 아니다.
