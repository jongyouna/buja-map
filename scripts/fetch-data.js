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
  const qqq = await fetchYahoo("QQQ", "max");
  console.log(`  ${qqq.length} rows`);

  console.log("Fetching SPCX (SpaceX)...");
  const spcx = await fetchYahoo("SPCX", "max");
  console.log(`  ${spcx.length} rows`);

  console.log("Fetching KOSPI200 현물지수 (Yahoo Finance)...");
  const k200 = await fetchYahoo("%5EKS200", "max");
  console.log(`  ${k200.length} rows`);

  console.log("Fetching VIX (Yahoo Finance)...");
  const vix = await fetchYahoo("%5EVIX", "max");
  console.log(`  ${vix.length} rows`);

  console.log("Fetching M2SL (US M2 liquidity)...");
  const m2All = await fetchM2();
  // 최근 30년치만 저장 (20년 조회 옵션 + 여유분)
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 30);
  const m2 = m2All.filter((d) => new Date(d.date) >= cutoff);
  console.log(`  ${m2.length} rows`);

  const data = {
    updatedAt: new Date().toISOString(),
    series: {
      nasdaq: { symbol: "QQQ", label: "나스닥(QQQ)", data: qqq },
      spacex: { symbol: "SPCX", label: "스페이스X(SPCX)", data: spcx },
      k200: { symbol: "^KS200", label: "코스피200 현물지수", data: k200 },
      vix: { symbol: "^VIX", label: "VIX 변동성지수", data: vix },
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
