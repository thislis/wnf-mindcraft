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
7. 발판/레버/버튼을 바라보며 `/fw trigger add <stage> <wall-id> <pad|lever|button> <wade|ember|any>`를 실행해 사용할 역할을 지정한다.
8. `setgoal`, `setbrief`, `validate`, `enable true` 순서로 마무리한다.
9. 시작 장치를 누르거나 `/fw stage start <id>`를 실행한다.

편집 명령에는 `/fw stage delete|sethold|setpoison`, `/fw wall delete|preview|restore`, `/fw trigger remove`도 포함된다. wall은 그룹당 1,024개, stage 전체 4,096개 블록으로 제한된다.

전체 명령은 `/fw help`에서 볼 수 있다. 생성되는 YAML 스키마는 `src/main/resources/stages/example.yml`을 참고한다.

## 인게임 역할 지정

OP 또는 `firewater.admin` 권한으로 다음 명령을 사용한다. 진행 중인 게임이 있으면 `/fw stage stop`으로 종료한 뒤 지정한다.

```text
/fw role set wade <플레이어명>
/fw role set ember <플레이어명>
/fw role set wade
/fw role list
/fw role clear wade
```

플레이어명을 생략하면 자신을 지정한다. 대상은 접속 중이어야 하며 한 명에게 두 역할을 중복 지정할 수 없다. 수동 지정은 해당 역할의 기존 전용 계정을 대체하고 `config.yml`의 `manual-players`에 저장되어 재시작 후에도 유지된다. `clear`는 해당 역할을 `players`에 설정된 전용 계정으로 되돌린다. 전용 계정 이름 자체를 수동 지정한 경우 `clear` 이후에는 그 계정에 전용 계정 제한이 다시 적용된다.

수동 참가자는 대기·플레이·리셋·종료·재접속 중에도 OP, 게임 모드, 인벤토리를 유지한다. 로비로 강제 이동하지 않고 게임 경계나 월드 밖으로 자유롭게 이동할 수 있다. 일반 상자·문 등은 게임 안팎에서 사용할 수 있고, 블록 설치·파괴·양동이는 실행 중인 게임 영역 밖에서 허용한다. 게임 영역 보호, 역할별 장치 접근, 영역 내 위험과 사망 판정, 출구 판정은 계속 적용된다. 게임 시작과 attempt 리셋 시에는 역할별 시작점으로 이동한다. 영역 밖의 일반 사망은 게임 실패로 처리하지 않는다.

수동 참가자에게는 게임 영역 안에서만 짧은 역할 포션을 갱신한다. 다른 포션은 지우지 않으며 역할 포션은 게임 종료나 영역 이탈 후 최대 2초 안에 만료된다(플레이어가 원래 가진 더 강하거나 긴 포션은 유지).

## 규칙

- 벽은 `defaultVisible XOR anyBoundTriggerActive`다. 같은 그룹의 입력 둘이 동시에 켜져도 한 번만 반전된다.
- 시작 장치는 button/lever만 허용하며 play bounds 밖의 운영 패널에 둘 수 있다. wall trigger에는 pad/lever/button을 사용할 수 있다.
- 모든 wall trigger는 `role: wade|ember|any` 접근 규칙을 가진다. 다른 역할의 레버·버튼 클릭은 취소되고,
  역할 제한 압력판은 지정된 역할이 올라섰을 때만 벽 신호를 낸다. 구형 YAML에서 role을 생략하면 `any`로 읽는다.
- wall은 정적·비중력·비대화형 BlockData만 허용한다. tile entity, waterlogged 블록, 유체와 맞닿은 wall은 거부하며 등록 wall 칸으로 유체가 흐르는 이벤트도 차단한다.
- Wade는 물에 안전하고 용암에 실패한다. Ember는 용암에 안전하고 물에 실패한다. 독은 둘 모두 실패한다.
- 위험 판정은 활성 스테이지 bounds 안에서만 동작한다. 물, 거품 기둥, 실제로 waterlogged 된 블록도 물 접촉으로 본다.
- 독은 기본적으로 `lime_carpet`, `green_stained_glass`, `green_concrete` 접촉이다.
- 한 명이 죽으면 실제 사망/리스폰 이벤트 후 두 명 모두 다음 attempt의 시작점으로 돌아간다.
- Wade와 Ember가 자기 출구를 동시에 10 tick 유지할 때만 클리어된다.
- 출구 좌표는 플레이어가 올라서는 단단한 표식 블록이다. 출구와 그 위 두 칸은 액체/독이 아니어야 하고, 위 두 칸은 통과 가능하며 모두 play bounds와 월드 높이 안에 있어야 stage가 시작된다.
- `players`에 설정된 기본 Wade/Ember는 전용 게임 계정이다. 플러그인이 켜진 동안 항상 non-OP, Adventure, 빈 인벤토리를 유지하며 stage 밖에서는 역할 포션도 제거한다.
- 전용 계정의 플레이어 hitbox가 play bounds 또는 stage world를 벗어나면 해당 attempt가 실패한다. 실행 중 stage 영역은 외부 플레이어의 변경과 참가자의 등록되지 않은 상호작용으로부터 보호된다.
- stage 시작 전에 `plugins/FirewaterGame/active-session.yml`을 원자적으로 기록한다. 강제 종료 후 다음 enable에서 wall/trigger default를 UUID가 일치하는 world에 복구한 뒤 새 session을 허용한다.

서버 메시지는 다음 prefix를 전송한다: `[FWG:START]`, `[FWG:RESET]`, `[FWG:CLEAR]`, `[FWG:ABORT]`. START에는 봇 명령 검증용 `world`, `min-x/min-y/min-z`, `max-x/max-y/max-z`가 포함된다. 짧은 메시지는 `minecraft:tell`, 240자를 넘는 START는 같은 vanilla incoming-whisper translation key를 쓰는 Adventure Component로 전달한다. 두 방식 모두 Mineflayer의 `whisper`/`messagestr` 경로에서 검증됐다.

저장소 루트의 `npm run smoke:firewater`는 임시 Paper 1.21.6 서버와 두 raw Mineflayer 클라이언트를 띄워 물/용암/독, 사망·리스폰, attempt reset, 양쪽 출구, FWG 메시지를 실제 프로토콜로 검증한 뒤 임시 서버를 삭제한다. 이 스모크는 콘솔 teleport/setblock을 사용하므로 Mindcraft·Codex 자율 클리어 증거는 아니다.


### Gem observation contracts

Stages with datapack proximity collectibles may declare `gems` entries with
`x`, `y`, `z`, `material`, `role` (`wade`, `ember`, or `any`),
`collection-offset-y`, and `collection-radius`. The collection center is
`(x + 0.5, y + collection-offset-y, z + 0.5)`. These entries describe the
existing datapack rules; the plugin does not grant items or break gem blocks.
See `examples/forest-gems-observation.yml` for the forest temple datapack's nine
collectibles. Keep this contract in sync when changing that datapack.

The START protocol includes `gems` and `interaction-roles`. Bots only expose
coordinates after a loaded target passes a line-of-sight check. Own/shared gems
use `!collectGemAt`, which follows a role-safe path into the collection radius
and waits for the server to remove the block. Other-role and unknown devices
are rejected. Observed own gems, permitted unpowered devices, and safe-liquid
routes take priority during exploration. Ordinary stained-glass decoration is
not treated as a collectible.
