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

async function fetchFred(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`FRED fetch failed for ${seriesId}: ${res.status}`);
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

async function fetchEcos(apiKey, tableCode, itemCode) {
  const now = new Date();
  const end = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 30);
  const startStr = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, "0")}`;
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/500/${tableCode}/M/${startStr}/${end}/${itemCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ECOS fetch failed for ${tableCode}/${itemCode}: ${res.status}`);
  const json = await res.json();
  const rows = json.StatisticSearch?.row || [];
  return rows.map((r) => ({
    date: `${r.TIME.slice(0, 4)}-${r.TIME.slice(4, 6)}-01`,
    value: parseFloat(r.DATA_VALUE),
  }));
}

function last30Years(series) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 30);
  return series.filter((d) => new Date(d.date) >= cutoff);
}

const DATA_PATH = path.join(__dirname, "..", "data", "data.json");

async function main() {
  console.log("Fetching QQQ (Nasdaq proxy)...");
  const qqq = await fetchYahoo("QQQ", "10y");
  console.log(`  ${qqq.length} rows`);

  console.log("Fetching SPCX (SpaceX)...");
  const spcx = await fetchYahoo("SPCX", "10y");
  console.log(`  ${spcx.length} rows`);

  console.log("Fetching KOSPI200 현물지수 (Yahoo Finance)...");
  const k200 = await fetchYahoo("%5EKS200", "10y");
  console.log(`  ${k200.length} rows`);

  console.log("Fetching VIX (Yahoo Finance)...");
  const vix = await fetchYahoo("%5EVIX", "10y");
  console.log(`  ${vix.length} rows`);

  console.log("Fetching M1SL (US M1 liquidity)...");
  // 2020년 5월 연준이 M1 정의를 변경(저축성예금 포함)하면서 그 이전 데이터와 단절됨
  // (2020-04 4,856.4B -> 2020-05 16,312.5B, +236%). 재정의 이후 데이터만 사용.
  const m1us = last30Years(await fetchFred("M1SL")).filter((d) => d.date >= "2020-05-01");
  console.log(`  ${m1us.length} rows`);

  console.log("Fetching M2SL (US M2 liquidity)...");
  const m2 = last30Years(await fetchFred("M2SL"));
  console.log(`  ${m2.length} rows`);

  const ecosKey = process.env.BOK_ECOS_API_KEY;
  let m1kr = [];
  let m2kr = [];
  if (ecosKey) {
    console.log("Fetching Korea M1 (BOK ECOS)...");
    m1kr = await fetchEcos(ecosKey, "161Y001", "BBLS00");
    console.log(`  ${m1kr.length} rows`);

    console.log("Fetching Korea M2 (BOK ECOS)...");
    m2kr = await fetchEcos(ecosKey, "161Y005", "BBHS00");
    console.log(`  ${m2kr.length} rows`);
  } else {
    console.log("BOK_ECOS_API_KEY not set, skipping Korea M1/M2");
  }

  const data = {
    updatedAt: new Date().toISOString(),
    series: {
      nasdaq: { symbol: "QQQ", label: "나스닥(QQQ)", data: qqq },
      spacex: { symbol: "SPCX", label: "스페이스X(SPCX)", data: spcx },
      k200: { symbol: "^KS200", label: "코스피200 현물지수", data: k200 },
      vix: { symbol: "^VIX", label: "VIX 변동성지수", data: vix },
      m1us: { symbol: "M1SL", label: "미국 M1 유동성", data: m1us },
      m2: { symbol: "M2SL", label: "미국 M2 유동성", data: m2 },
      m1kr: { symbol: "BOK-ECOS", label: "한국 M1 유동성", data: m1kr },
      m2kr: { symbol: "BOK-ECOS", label: "한국 M2 유동성", data: m2kr },
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
