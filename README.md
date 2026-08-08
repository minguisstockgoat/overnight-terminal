# 📟 OVERNIGHT TERMINAL

블룸버그 터미널 스타일의 **한국 투자자용 오버나잇 마켓 대시보드**.
미장이 열리는 한국의 밤 시간대(18:00~06:00 KST)에 봐야 할 지표를 한 화면에 실시간으로 모았다.

**라이브**: https://minguisstockgoat.github.io/overnight-terminal/

## 지표 구성 근거

텔레그램 아카이브(2026-06-29~07-29, 시황·리서치 채널 전체) 전문검색으로 언급 빈도를 집계해
가장 많이 언급된 지표를 타일로 선정했다. 유가(WTI)·미국채 금리·환율(DXY/엔화)·VIX·야간선물·
나스닥 선물·비트코인·엔비디아가 포화 수준, SOX·천연가스·구리·금이 그 다음.
우측 "TG 언급 빈도" 패널에 반영되어 있다.

## 패널

| 패널 | 심볼 |
|---|---|
| KOREA · OVERNIGHT | **K200 야간선물(KRX 실물)**, 원/달러(KRW=X), EWY(MSCI Korea), KOSPI200, KOSPI |
| EQUITY FUTURES & VOL | ES/NQ/YM/RTY(미 지수선물), NKD(니케이 선물), SOX, VIX |
| RATES | 미국채 10Y/5Y/30Y 수익률, ZN/ZT 국채선물(24h) |
| FX | 달러인덱스, 엔/달러, 유로/달러 |
| COMMODITIES | WTI, 브렌트, 천연가스(HH/TTF), 금, 은, 구리 |
| CRYPTO | BTC, ETH — Binance WebSocket 실시간 푸시 |
| US TECH | NVDA, TSLA, SKHY(SK하이닉스 ADR), MU — 프리·애프터 포함 |
| FED WATCH | 잔여 FOMC 회의별 인상/인하 확률 + 연말 누적 내재폭(bp) 추이 |

## FED WATCH 패널

CME FedWatch와 동일한 원리로 **30일 Fed Funds 선물(ZQ 월물)에서 직접 산출**한다
(CME 사이트는 봇 차단이 심해 스크레이핑 대신 원데이터 계산 방식 채택).

- 회의 전후 내재 EFFR 차이 ÷ 25bp → 인상/인하 확률 (월말 회의는 익월 월물, 월중 회의는 일수 가중 역산)
- 실시간: 클라이언트가 60초마다 ZQ 월물 6~7개를 폴링해 재계산
- 일별 이력: GitHub Actions(`fedwatch.yml`, 매영업일 06:15 KST)가 `scripts/fedwatch_snapshot.mjs`를 돌려
  `data/fedwatch_history.json`에 기록 → 패널 우측 "연말 내재 변동폭(bp) 추이" 차트
- **유지보수**: 연준이 금리를 바꾸거나 차년도 FOMC 일정이 나오면 `fomc.json`만 갱신
  (기준금리가 오래되면 패널에 ⚠ 경고 표시됨). 계산 로직은 `app.js` `computeFedPath()`와
  스냅샷 스크립트에 중복 구현 — 수정 시 둘 다 반영(KEEP IN SYNC).

## K200 야간선물 패널

KRX는 2025-06-09부터 코스피200 야간선물시장을 **직접** 운영한다(월~금 18:00 ~ 익일 06:00 KST).
프록시(EWY·원/달러) 대신 **실물 시세**를 띄우되, EWY와 원/달러는 보조 지표로 남겼다.

**왜 릴레이가 필요한가** — KIS OpenAPI는 야간 시세를 REST로 주지 않는다.
`inquire-price`가 `FID_COND_MRKT_DIV_CODE=JF`를 받아주긴 하지만 응답이 비고, 분봉도 주간(~15:45)까지만
나온다. 실시간 웹소켓 **`H0MFCNT0`(KRX야간선물 실시간종목체결)** 만 야간 체결을 흘려준다.
브라우저에 KIS 키를 둘 수도 없으므로 중계가 필요하다.

```
Mac mini (항상 켜짐)                    Cloudflare Worker           브라우저
scripts/k200_night_relay.mjs  ──POST──▶  worker/k200-night  ──GET──▶  app.js
  KIS 웹소켓 H0MFCNT0 상주                 KV에 최신 스냅샷 보관         20초 폴링
```

- **근월물 코드 자동 해석** — 코스피200 선물 단축코드는 `A01` + 연(1자리) + 월(2자리)
  (예: `A01609` = 2026년 9월물). 분기월물(3·6·9·12)의 둘째 목요일 만기를 계산해 후보를 만들고,
  주간 시세 REST로 실물 확인 후 채택한다. 분기 롤오버를 알아서 따라간다.
- **등락 기준은 같은 종목의 주간 정규장 종가**(타일 하단에 `전일`로 병기).
- 릴레이는 1분봉 시계열을 함께 실어 보내 **페이지를 새로 열어도 스파크라인이 바로 그려진다.**
- 배지: `LIVE`(수신 중) / `마감`(06:00 종료) / `STALE`(3분 이상 갱신 없음) / `OFF`(엔드포인트 불통).
  엔드포인트가 죽어도 **이 타일만 실패**하고 나머지 대시보드는 그대로 돈다.
- push 주기는 기본 60초 — Cloudflare KV 무료 한도(1,000 writes/day)를 넘지 않게 잡았다.
  Workers 유료 플랜이면 `RELAY_PUSH_SEC` 환경변수로 낮출 수 있다.

### 설치

```bash
# 1) Worker 배포
cd worker/k200-night
npx wrangler kv namespace create K200      # 출력된 id 를 wrangler.toml 에 기입
npx wrangler secret put RELAY_TOKEN        # 임의의 긴 문자열
npx wrangler deploy                        # 배포 주소를 app.js K200_NIGHT_URL 에 반영

# 2) Mac mini 릴레이 점검 (야간장 열린 평일 18:00~06:00 에)
node scripts/k200_night_relay.mjs --once

# 3) launchd 등록 (평일 17:55 시작 → 06:05 자동 종료)
sed -i '' "s#REPO_PATH#$(pwd)#g" com.minguis.k200night.plist   # RELAY_TOKEN 도 채울 것
cp com.minguis.k200night.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.minguis.k200night.plist
```

KIS 키(`KIS_APP_KEY` / `KIS_APP_SECRET`)는 `~/.config/secrets/keys.env` 에서 자동으로 읽는다.

## 아키텍처

- **정적 사이트** (GitHub Pages, 빌드 없음): `index.html` + `style.css` + `app.js`
- K200 야간선물: Mac mini 릴레이 → Cloudflare Worker → 20초 폴링 (위 참고)
- 시세: Yahoo Finance `v8/finance/spark`(15심볼 배치, 20초 폴링) + `v8/finance/chart`(개별주, 프리·애프터 포함, 30초)
- CORS 우회: 전용 Cloudflare Worker(`hynix-proxy.eogks879.workers.dev`, yahoo·naver 호스트만 중계) → 실패 시 공개 프록시(allorigins, codetabs) 자동 폴백
- BTC/ETH: Binance WebSocket `miniTicker` 실시간 푸시(폴백은 Yahoo 폴링)
- 스파크라인: 당일 5분봉, 전일종가 점선 기준선, 호버 시 시각·가격 툴팁
- 등락 색상: 기본 블룸버그식(녹=상승) ↔ 한국식(빨=상승) 토글, localStorage 저장
- 탭 백그라운드 시 폴링 자동 감속(2~3분)

## 주의

Yahoo 시세는 지연될 수 있다(선물·FX는 대체로 실시간에 가깝고, 지수는 최대 15분 지연 가능).
투자 판단 참고용이며 시세 정확성을 보장하지 않는다.
