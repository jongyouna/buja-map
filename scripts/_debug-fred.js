// 일회성 디버그: FRED에서 미국 M1, 한국 M1/M2(광의통화) 시리즈 ID 후보 검증. 사용 후 삭제 예정.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) buja-map-dashboard";

const candidates = [
  "M1SL", // US M1
  "WM1NS", // US M1 weekly NSA (fallback candidate)
  "MANMM101KRM189S", // Korea M1 (OECD MEI via FRED)
  "MABMM301KRM189S", // Korea M3/broad money (OECD MEI via FRED)
  "MYAGM2KRM189N", // Korea M2 candidate
  "QKRM2MABMM301N", // Korea M2 candidate
];

async function tryId(id) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      console.log(`FAIL ${id}: status=${res.status}`);
      return;
    }
    const text = await res.text();
    const lines = text.trim().split("\n");
    const header = lines[0];
    const dataLines = lines.slice(1).filter((l) => l && !l.endsWith(","));
    const last = dataLines[dataLines.length - 1];
    const first = dataLines[0];
    console.log(
      `OK   ${id}: header="${header}" rows=${dataLines.length} first="${first}" last="${last}"`
    );
  } catch (e) {
    console.log(`ERR  ${id}: ${e.message}`);
  }
}

async function main() {
  for (const id of candidates) {
    await tryId(id);
  }
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
