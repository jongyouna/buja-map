// 네이버 부동산(m.land) 아파트 매물을 수집해 ../data/naver-land.json 생성
//
// ※ 중요 ※
// 네이버는 land.naver.com 계열 도메인을 데이터센터 IP(AWS/Azure/GitHub Actions 등)에서
// 접속하면 응답 없이 연결을 끊습니다(403이 아니라 무한 대기 → 타임아웃). 실제로 GitHub
// Actions 러너에서 www.naver.com은 200으로 열리지만 m.land/new.land는 모두 타임아웃입니다.
// 따라서 이 스크립트는 한국 가정용 회선(=평소 네이버 부동산이 열리는 PC)에서 실행해야 합니다.
//
//   node scripts/fetch-naver-land.js
//   git add data/naver-land.json && git commit -m "chore: 네이버 매물 갱신" && git push
//
// 수집에 실패하면 기존 data/naver-land.json을 건드리지 않고 0이 아닌 코드로 종료합니다.

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const OUT_PATH = path.join(__dirname, "..", "data", "naver-land.json");

// 수집 대상 구(區). cortarNo는 네이버 지역코드(법정동코드 10자리 체계).
const TARGET_DISTRICTS = [
  { cortarNo: "1168000000", name: "서울 강남구" },
  { cortarNo: "1171000000", name: "서울 송파구" },
  { cortarNo: "1165000000", name: "서울 서초구" },
  { cortarNo: "1144000000", name: "서울 마포구" },
  { cortarNo: "1120000000", name: "서울 성동구" },
];

// A1=매매, B1=전세
const TRADE_TYPES = ["A1", "B1"];

const REQUEST_TIMEOUT_MS = 15000;
const DELAY_BETWEEN_REQUESTS_MS = 400; // 네이버가 단시간 대량 호출을 차단하므로 간격을 둠
const MAX_PAGES_PER_QUERY = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function naverFetch(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "User-Agent": UA,
      Referer: "https://m.land.naver.com/",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 파싱 실패 (${url}): ${text.slice(0, 200)}`);
  }
}

// 상위 지역코드의 하위 지역 목록(구→동)을 반환. [{cortarNo, cortarNm, lat, lon}]
async function fetchRegionList(cortarNo) {
  const json = await naverFetch(`https://m.land.naver.com/map/getRegionList?cortarNo=${cortarNo}`);
  return json?.result?.list || [];
}

// 동 하나의 매물 목록을 페이지네이션으로 모두 수집
async function fetchArticles(dong, tradeType) {
  const { cortarNo, lat, lon } = dong;
  // 동 중심 좌표 주변으로 넉넉한 bounding box를 잡는다(약 ±0.03도 ≈ ±3km).
  const btm = (lat - 0.03).toFixed(6);
  const top = (lat + 0.03).toFixed(6);
  const lft = (lon - 0.04).toFixed(6);
  const rgt = (lon + 0.04).toFixed(6);

  const articles = [];
  for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
    const url =
      `https://m.land.naver.com/cluster/ajax/articleList?itemId=&mapKey=&lgeo=&showR0=` +
      `&rletTpCd=APT&tradTpCd=${tradeType}&z=14&lat=${lat}&lon=${lon}` +
      `&btm=${btm}&lft=${lft}&top=${top}&rgt=${rgt}` +
      `&cortarNo=${cortarNo}&page=${page}&sort=rank`;

    const json = await naverFetch(url);
    const body = json?.body || [];
    articles.push(...body);
    if (!json?.more || body.length === 0) break;
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }
  return articles;
}

// "125,000" / 125000 / "12억 5,000" 형태를 만원 단위 숫자로 정규화
function parsePrice(prc) {
  if (prc == null) return null;
  if (typeof prc === "number") return Number.isFinite(prc) ? prc : null;
  const digits = String(prc).replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const PYEONG_PER_M2 = 3.305785;

// 매물 배열을 단지(atclNm) 단위로 묶어 통계 산출
function summarizeByComplex(articles, tradeType) {
  const groups = new Map();
  for (const a of articles) {
    const name = a.atclNm;
    const price = parsePrice(a.prc);
    if (!name || price == null) continue;
    const area = parseFloat(a.spc1); // 공급면적(㎡)
    if (!groups.has(name)) groups.set(name, { prices: [], areas: [], pyeongPrices: [], complexNo: a.hscpNo || null });
    const g = groups.get(name);
    g.prices.push(price);
    if (Number.isFinite(area) && area > 0) {
      g.areas.push(area);
      g.pyeongPrices.push(price / (area / PYEONG_PER_M2));
    }
    if (!g.complexNo && a.hscpNo) g.complexNo = a.hscpNo;
  }

  const out = [];
  for (const [complexName, g] of groups) {
    const prices = g.prices.slice().sort((x, y) => x - y);
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    out.push({
      complexName,
      complexNo: g.complexNo,
      tradeType,
      count: prices.length,
      minPrice: prices[0],
      medianPrice: median(prices),
      maxPrice: prices[prices.length - 1],
      avgPyeongPrice: avg(g.pyeongPrices),
      avgArea: avg(g.areas),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

async function main() {
  const regions = [];

  for (const district of TARGET_DISTRICTS) {
    console.log(`\n=== ${district.name} (${district.cortarNo}) ===`);
    let dongs;
    try {
      dongs = await fetchRegionList(district.cortarNo);
    } catch (e) {
      throw new Error(
        `${district.name} 지역 목록 조회 실패: ${e.message}\n` +
          `네이버가 데이터센터 IP를 차단하므로, 한국 가정용 회선 PC에서 실행해야 합니다.`
      );
    }
    console.log(`  하위 동 ${dongs.length}개`);

    const complexes = [];
    for (const dong of dongs) {
      for (const tradeType of TRADE_TYPES) {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        try {
          const articles = await fetchArticles(dong, tradeType);
          const summarized = summarizeByComplex(articles, tradeType);
          complexes.push(...summarized);
          console.log(`  ${dong.cortarNm} ${tradeType}: 매물 ${articles.length}건 → 단지 ${summarized.length}곳`);
        } catch (e) {
          console.warn(`  ${dong.cortarNm} ${tradeType}: 수집 실패 (${e.message}) - 건너뜀`);
        }
      }
    }

    regions.push({ cortarNo: district.cortarNo, name: district.name, complexes });
  }

  const totalComplexes = regions.reduce((s, r) => s + r.complexes.length, 0);
  if (totalComplexes === 0) {
    throw new Error("수집된 매물이 한 건도 없습니다. 네이버 차단 여부를 확인하세요. 기존 파일을 유지합니다.");
  }

  const payload = { updatedAt: new Date().toISOString(), source: "네이버 부동산 (m.land)", regions };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n저장 완료: ${OUT_PATH} (단지 ${totalComplexes}곳)`);
}

main().catch((err) => {
  console.error("\n[실패]", err.message);
  process.exit(1);
});
