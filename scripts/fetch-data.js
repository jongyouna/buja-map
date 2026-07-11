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

// investing.com 코스피200 선물 히스토리 테이블 스크래핑 (비공식 HTML 구조 의존 — 사이트 개편 시 실패 가능)
async function fetchK200Futures() {
  const url = "https://kr.investing.com/indices/korea-200-futures-historical-data";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Investing.com fetch failed: ${res.status}`);
  const html = await res.text();

  let tableHtml = null;
  const byTestId = html.match(/<table[^>]*data-test="historical-data-table"[^>]*>([\s\S]*?)<\/table>/);
  if (byTestId) {
    tableHtml = byTestId[1];
  } else {
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)];
    const withClose = tables.find((t) => t[1].includes("종가"));
    tableHtml = withClose ? withClose[1] : null;
  }
  if (!tableHtml) throw new Error("historical-data-table을 찾을 수 없음 (페이지 구조 변경 가능성)");

  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const series = [];
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, "").trim()
    );
    if (cells.length < 2) continue;
    const dateMatch = cells[0].match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (!dateMatch) continue;
    const [, y, m, d] = dateMatch;
    const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const close = parseFloat(cells[1].replace(/,/g, ""));
    if (isNaN(close)) continue;
    series.push({ date, close });
  }
  series.sort((a, b) => a.date.localeCompare(b.date));
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
