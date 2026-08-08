/* K200 야간선물 릴레이 엔드포인트.
 *
 * Mac mini의 scripts/k200_night_relay.mjs 가 KIS 웹소켓에서 받은 최신 시세를 POST 하고,
 * 대시보드(app.js)가 GET 으로 읽는다. KIS 키는 Mac 쪽에만 있고 여기로 넘어오지 않는다.
 *
 *   POST /   헤더 x-relay-token: <RELAY_TOKEN>   본문 = 시세 JSON
 *   GET  /   → 최신 시세 JSON (CORS 허용, 캐시 없음)
 *
 * 배포:
 *   cd worker/k200-night
 *   npx wrangler kv namespace create K200          # 출력된 id 를 wrangler.toml 에 기입
 *   npx wrangler secret put RELAY_TOKEN            # Mac 쪽 RELAY_TOKEN 과 동일하게
 *   npx wrangler deploy
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-relay-token",
  "access-control-max-age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

/* 릴레이가 죽거나 맥이 꺼졌을 때 대시보드가 옛 숫자를 실시간인 양 그리지 않도록,
 * 마지막 수신이 오래됐으면 stale 을 달아 보낸다(장중일 때만 의미 있음). */
const STALE_MS = 180_000;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "POST") {
      const token = request.headers.get("x-relay-token") || "";
      if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) return json({ error: "unauthorized" }, 401);

      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (typeof body?.price !== "number") return json({ error: "price required" }, 400);

      body.receivedAt = new Date().toISOString();
      await env.K200.put("latest", JSON.stringify(body));
      return json({ ok: true });
    }

    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const raw = await env.K200.get("latest");
    if (!raw) return json({ status: "no_data" }, 404);

    const d = JSON.parse(raw);
    const age = Date.now() - Date.parse(d.receivedAt || d.ts || 0);
    d.ageSec = Number.isFinite(age) ? Math.round(age / 1000) : null;
    d.stale = d.session === "open" && age > STALE_MS;
    return json(d);
  },
};
