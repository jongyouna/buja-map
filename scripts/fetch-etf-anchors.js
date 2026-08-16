// 기간별 수익률(일간·주간·월간·연간)을 계산하는 데 쓸 "기준 시점 종가"를 모아
// data/etf-anchors.json 으로 저장한다.
//
// 화면에서 필요한 것은 과거 전체 시세가 아니라 네 시점의 종가뿐이다(1거래일·1주·1개월·1년 전).
// 전 종목의 일별 시세를 그대로 배포하면 파일이 수 MB가 되지만, 네 시점만 담으면 수십 KB로 끝난다.
//
// 브라우저에서 직접 받지 않는 이유는 시세 API가 CORS를 허용하지 않기 때문이다
// (scripts/fetch-etf-quotes.js의 설명 참고). 그래서 서버(GitHub Actions)에서 받아 정적 파일로 낸다.
//
// 요청 수가 종목 수만큼(약 900건) 되므로 이 스크립트는 하루 한 번만 돌린다.
// 장중 10분마다 도는 시세 갱신(update-etf-quotes.yml)과 분리해 둔 이유가 이것이다.

const fs = require("fs");
const path = require("path");

const QUOTES = path.join(__dirname, "..", "data", "etf-quotes.json");
const OUT = path.join(__dirname, "..", "data", "etf-anchors.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 동시에 너무 많이 보내면 상대 서버에 부담이 되고 차단당할 수도 있다.
const CONCURRENCY = 8;
const RETRIES = 2;

// 기준 시점. 값은 "며칠 전"이다. 주말·공휴일이면 그 이전 거래일 종가를 쓴다.
const PERIODS = [
  { key: "d1", label: "일간", daysAgo: 1 },
  { key: "w1", label: "주간", daysAgo: 7 },
  { key: "m1", label: "월간", daysAgo: 30 },
  { key: "y1", label: "연간", daysAgo: 365 },
];

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function daysAgoYmd(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

async function fetchDaily(code) {
  // 1년 전보다 넉넉히 앞에서부터 받아야 연간 기준일이 휴장일이어도 그 이전 거래일을 찾을 수 있다.
  const start = daysAgoYmd(400);
  const end = daysAgoYmd(0);
  const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${start}0000&endDateTime=${end}2359`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`시세 응답 ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("시세 형식이 예상과 다릅니다");
  // localDate(YYYYMMDD) 오름차순으로 정리한다.
  return rows
    .map((r) => ({ date: String(r.localDate || ""), close: Number(r.closePrice) }))
    .filter((r) => /^\d{8}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 기준일이 휴장일일 수 있으므로 "그 날짜 이하에서 가장 최근" 종가를 쓴다.
function closeOnOrBefore(series, targetYmd) {
  let hit = null;
  for (const row of series) {
    if (row.date <= targetYmd) hit = row;
    else break;
  }
  return hit;
}

async function withRetry(fn, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

async function main() {
  if (!fs.existsSync(QUOTES)) {
    throw new Error(`${QUOTES} 가 없습니다. fetch-etf-quotes.js 를 먼저 돌려 주세요.`);
  }
  const quotes = JSON.parse(fs.readFileSync(QUOTES, "utf-8"));
  const codes = (quotes.items || []).map((i) => i.code);
  if (!codes.length) throw new Error("종목 목록이 비어 있습니다");

  const targets = PERIODS.map((p) => ({ ...p, ymd: daysAgoYmd(p.daysAgo) }));
  console.log(`기준일: ${targets.map((t) => `${t.label} ${t.ymd}`).join(" / ")}`);
  console.log(`${codes.length}종목 조회 시작 (동시 ${CONCURRENCY})`);

  let done = 0;
  let failed = 0;
  const items = {};

  await runPool(codes, async (code) => {
    try {
      const series = await withRetry(() => fetchDaily(code), RETRIES);
      const entry = {};
      for (const t of targets) {
        const hit = closeOnOrBefore(series, t.ymd);
        // 상장한 지 얼마 안 된 종목은 1년 전 종가가 없다. 그런 칸은 null로 두고
        // 화면에서 그 종목만 해당 기간 계산에서 빼면 된다.
        entry[t.key] = hit ? hit.close : null;
      }
      if (Object.values(entry).some((v) => v !== null)) items[code] = entry;
    } catch (e) {
      failed++;
    } finally {
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${codes.length} (실패 ${failed})`);
    }
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "네이버 금융 일별 시세",
    // 어느 날짜의 종가를 기준으로 삼았는지 화면에서 그대로 보여 준다.
    baseDates: Object.fromEntries(targets.map((t) => [t.key, t.ymd])),
    labels: Object.fromEntries(targets.map((t) => [t.key, t.label])),
    count: Object.keys(items).length,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), "utf-8");
  console.log(`${payload.count}종목 저장 (실패 ${failed}) -> ${OUT}`);
  const sample = Object.entries(items)[0];
  if (sample) console.log(`예시: ${sample[0]} ${JSON.stringify(sample[1])}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
