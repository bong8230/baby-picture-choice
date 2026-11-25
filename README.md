# baby-picture-choice

아기 사진 후보를 주 단위로 골라, 휴대폰에서 토너먼트 방식으로 투표하는 앱입니다.
PC에서 Node 서버(127.0.0.1:8790, 런타임 의존성 없음)를 실행하고 Tailscale로 노출합니다.

## 첫 설정
1. `config.example.json`을 `config.json`으로 복사합니다.
2. `config.json`의 `adminLogin`에 본인 Tailscale 로그인 주소를 적습니다.
   `publicBase`에는 이 PC의 Tailscale 주소를 적습니다. 예: `https://my-pc.example-tailnet.ts.net:10000`
   (`tailscale status --json`의 `Self.DNSName`에서 확인할 수 있습니다.)
3. `npm run funnel:off`를 한 번 실행합니다. 포트 10000을 tailnet 전용 serve로 설정합니다.
   (`tailscale serve --bg --https=10000 http://127.0.0.1:8790`와 같은 설정입니다.)

## 한 주 사용 순서
1. `npm start`로 서버를 켭니다.
2. 관리 화면에서 사진을 올립니다.
3. 관리 화면에서 투표를 시작합니다.
4. `npm run funnel:on`으로 공개 접속을 엽니다.
5. 투표 링크를 전달합니다.
6. 투표가 끝나면 결과를 확인합니다.
7. `npm run funnel:off`로 공개 접속을 닫습니다.

관리 화면: `<publicBase>/admin` (예: `https://my-pc.example-tailnet.ts.net:10000/admin`)

## 갤러리에서 공유로 올리기

1. 갤럭시 Chrome에서 관리 페이지를 열고 메뉴에서 **홈 화면에 추가** 또는 **앱 설치**를 선택합니다.
2. 삼성 갤러리에서 사진을 선택하고 **공유**를 누른 뒤 **아기사진**을 선택합니다.
3. 관리 앱에서 분석 결과를 확인하고 사진을 올립니다.

갤러리의 공유 시 HEIF 변환 설정이 켜져 있으면 JPG로 전달되며 그대로 올릴 수 있습니다.

## 백그라운드 실행 (Windows)
- 명령 프롬프트: `start /min node server.js`
- PowerShell: `Start-Process -WindowStyle Minimized node server.js`

## 안전 수칙
- funnel은 투표 기간에만 켭니다.
- 투표가 끝나면 반드시 `npm run funnel:off`를 실행합니다. 끝난 주의 투표 링크는 이때 자동으로 폐기됩니다.
- `tailscale serve reset`은 절대 실행하지 않습니다. 다른 포트(443, 8443)의 설정이 함께 지워집니다.

## 명령어
- `npm run funnel:on` : 투표 기간용 공개 접속(Funnel)
- `npm run funnel:off` : tailnet 전용으로 전환하고, 끝난 주의 투표 링크를 폐기
- `npm run funnel:status` : 포트 10000 현재 상태 확인

스크립트는 443, 8443 포트 설정을 건드리지 않으며, 그 설정이 바뀌면 exit 1로 중단합니다.
