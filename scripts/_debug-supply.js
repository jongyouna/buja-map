// 일회성 디버그: odcloud 입주예정물량정보 API 실제 호출 테스트(인증 방식/응답 스키마 확인). 사용 후 삭제 예정.
// 주의: URL(인증키 포함)은 절대 로그에 출력하지 않음 — 파싱된 JSON 내용만 출력.
const KEY = process.env.MOLIT_DATA_API_KEY;
if (!KEY) {
  console.error("MOLIT_DATA_API_KEY 없음");
  process.exit(1);
}

const PATH = "15111714/v1/uddi:0b257760-ac19-4841-adb4-b38b4d153397";

async function tryQueryParam() {
  console.log("\n=== 방식1: serviceKey 쿼리파라미터 ===");
  const url = `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5&serviceKey=${encodeURIComponent(KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  console.log("status:", res.status, "length:", text.length);
  console.log("body head:", text.slice(0, 1500));
}

async function tryAuthHeader() {
  console.log("\n=== 방식2: Authorization 헤더(Infuser 방식) ===");
  const url = `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5`;
  const res = await fetch(url, { headers: { Authorization: `Infuser ${KEY}` } });
  const text = await res.text();
  console.log("status:", res.status, "length:", text.length);
  console.log("body head:", text.slice(0, 1500));
}

async function main() {
  await tryQueryParam();
  await tryAuthHeader();
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
