# Resource Monitor Lite

code-server와 VS Code에서 CPU와 메모리 사용량을 가볍게 확인하는 확장입니다. TypeScript 빌드 과정 없이 plain JavaScript로 동작합니다.

## 기능

- 상태바에 CPU / 메모리 사용률 표시
- 대시보드에서 CPU, 메모리, load average, uptime, 확장 프로세스 메모리 표시
- Linux에서는 cgroup v1/v2 CPU quota와 메모리 제한을 우선 반영하고, 없으면 host 기준 값으로 계산
- 기본 1초 주기로 새로고침, 설정에서 변경 가능

## code-server에서 사용하기

VSIX 파일을 생성합니다.

```bash
npm run package
```

생성된 VSIX를 설치합니다.

```bash
code-server --install-extension dist/resource-monitor-lite-0.0.1.vsix
```

code-server를 reload한 뒤 Command Palette에서 아래 명령을 실행합니다.

```text
Resource Monitor Lite: Show Dashboard
```

## 설정

- `resourceMonitorLite.refreshIntervalMs`
- `resourceMonitorLite.statusBarFormat`

## 개발

이 확장은 의도적으로 plain JavaScript로 작성되어 있습니다. 진입점은 `extension.js`이며, TypeScript 컴파일 없이 code-server에서 로드할 수 있습니다.

자주 쓰는 명령:

```bash
npm run check
npm run package
```

## 라이선스

MIT 라이선스입니다. 자세한 내용은 [LICENSE](./LICENSE)를 참고하세요.
