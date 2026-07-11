// 매일 실행: SPCX, QQQ(나스닥 프록시), M2SL 데이터를 받아 ../data/data.json 생성
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) buja-map-dashboard";

async function fetchYahoo(symbol, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: ${res.status}`);
  const json = await res.json();
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const closes = result.indicators.quote[0].close || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    series.push({ date, close: closes[i] });
  }
  return series;
}

// investing.com 비공식 내부 API 사용 (api.investing.com — 브라우저처럼 헤더 위장, 봇 차단으로 실패 가능)
const INVESTING_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Domain-Id": "kr",
  Referer: "https://kr.investing.com/indices/korea-200-futures-historical-data",
  Origin: "https://kr.investing.com",
  "X-Requested-With": "XMLHttpRequest",
};

async function findK200PairId() {
  const url = "https://api.investing.com/api/search/v2/search?q=" + encodeURIComponent("Korea 200 Futures");
  const res = await fetch(url, { headers: INVESTING_HEADERS });
  if (!res.ok) throw new Error(`Investing.com search API 실패: ${res.status}`);
  const json = await res.json();
  const candidates = json.quotes || json.All || [];
  const match =
    candidates.find((c) => /korea\s*200\s*futures/i.test(c.name || c.symbol || "")) || candidates[0];
  const pairId = match && (match.pairId ?? match.pair_ID ?? match.pairID);
  if (!pairId) throw new Error("Investing.com 검색 결과에서 instrument ID를 찾지 못함");
  return pairId;
}

async function fetchK200Futures() {
  const pairId = await findK200PairId();

  const end = new Date();
  const start = new Date(end.getTime() - 400 * 86400000); // 최근 약 13개월
  const fmt = (d) => d.toISOString().slice(0, 10);
  const histUrl = `https://api.investing.com/api/financialdata/historical/${pairId}?start-date=${fmt(
    start
  )}&end-date=${fmt(end)}&time-frame=Daily&add-missing-rows=false`;

  const res = await fetch(histUrl, { headers: INVESTING_HEADERS });
  if (!res.ok) throw new Error(`Investing.com historical API 실패: ${res.status}`);
  const json = await res.json();
  const rows = json.data || [];

  const series = rows
    .map((r) => {
      const ts = r.rowDateTimestamp || r.rowDate;
      const date = new Date(ts).toISOString().slice(0, 10);
      const close =
        typeof r.last_closeRaw === "number" ? r.last_closeRaw : parseFloat(String(r.last_close).replace(/,/g, ""));
      return { date, close };
    })
    .filter((d) => !isNaN(d.close) && d.date !== "Invalid Date");
  series.sort((a, b) => a.date.localeCompare(b.date));
  if (series.length === 0) throw new Error("Investing.com historical API 응답에 유효한 데이터가 없음");
  return series;
}

async function fetchM2() {
  const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`FRED fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").slice(1); // skip header
  const series = lines
    .map((line) => {
      const [date, value] = line.split(",");
      return { date, value: value === "." ? null : parseFloat(value) };
    })
    .filter((d) => d.value != null);
  return series;
}

const DATA_PATH = path.join(__dirname, "..", "data", "data.json");

async function main() {
  console.log("Fetching QQQ (Nasdaq proxy)...");
  const qqq = await fetchYahoo("QQQ", "2y");
  console.log(`  ${qqq.length} rows`);

  console.log("Fetching SPCX (SpaceX)...");
  const spcx = await fetchYahoo("SPCX", "2y");
  console.log(`  ${spcx.length} rows`);

  console.log("Fetching KOSPI200 선물(investing.com)...");
  let k200 = [];
  try {
    k200 = await fetchK200Futures();
    console.log(`  ${k200.length} rows`);
  } catch (e) {
    console.warn(`  실패, 이전 데이터 유지: ${e.message}`);
    try {
      const prev = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
      k200 = prev.series?.k200?.data || [];
    } catch {
      k200 = [];
    }
  }

  console.log("Fetching M2SL (US M2 liquidity)...");
  const m2All = await fetchM2();
  // 최근 5년치만 저장 (전체 히스토리는 불필요)
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const m2 = m2All.filter((d) => new Date(d.date) >= cutoff);
  console.log(`  ${m2.length} rows`);

  const data = {
    updatedAt: new Date().toISOString(),
    series: {
      nasdaq: { symbol: "QQQ", label: "나스닥(QQQ)", data: qqq },
      spacex: { symbol: "SPCX", label: "스페이스X(SPCX)", data: spcx },
      k200: { symbol: "KOSPI200F", label: "코스피200 선물", data: k200 },
      m2: { symbol: "M2SL", label: "미국 M2 유동성", data: m2 },
    },
  };

  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`Saved to ${DATA_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
