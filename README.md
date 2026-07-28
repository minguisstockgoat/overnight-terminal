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
| KOREA · OVERNIGHT PROXY | 원/달러(KRW=X), EWY(MSCI Korea), KOSPI200, KOSPI |
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

> **K200 야간선물**: KRX 야간파생(18:00~익일 06:00) 시세는 무료 실시간 피드가 없다.
> 같은 시간대에 거래되는 **EWY(미국 상장 MSCI Korea ETF) + 원/달러**를 야간 방향 프록시로 쓰고,
> 패널에 명시해 두었다. (증권사 API 연동 시 실물 시세로 교체 가능)

## 아키텍처

- **정적 사이트** (GitHub Pages, 빌드 없음): `index.html` + `style.css` + `app.js`
- 시세: Yahoo Finance `v8/finance/spark`(15심볼 배치, 20초 폴링) + `v8/finance/chart`(개별주, 프리·애프터 포함, 30초)
- CORS 우회: 전용 Cloudflare Worker(`hynix-proxy.eogks879.workers.dev`, yahoo·naver 호스트만 중계) → 실패 시 공개 프록시(allorigins, codetabs) 자동 폴백
- BTC/ETH: Binance WebSocket `miniTicker` 실시간 푸시(폴백은 Yahoo 폴링)
- 스파크라인: 당일 5분봉, 전일종가 점선 기준선, 호버 시 시각·가격 툴팁
- 등락 색상: 기본 블룸버그식(녹=상승) ↔ 한국식(빨=상승) 토글, localStorage 저장
- 탭 백그라운드 시 폴링 자동 감속(2~3분)

## 주의

Yahoo 시세는 지연될 수 있다(선물·FX는 대체로 실시간에 가깝고, 지수는 최대 15분 지연 가능).
투자 판단 참고용이며 시세 정확성을 보장하지 않는다.
