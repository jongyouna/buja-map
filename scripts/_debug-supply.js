// 일회성 디버그: odcloud.kr Swagger 스펙에서 실제 엔드포인트(uddi)와 파라미터 확인. 사용 후 삭제 예정.
async function main() {
  const url = "https://infuser.odcloud.kr/oas/docs?namespace=15111714/v1";
  console.log(`=== ${url} ===`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    const text = await res.text();
    console.log(`status=${res.status} length=${text.length}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.log("JSON 파싱 실패, 원문 앞부분:", text.slice(0, 2000));
      return;
    }
    console.log("paths:", JSON.stringify(Object.keys(json.paths || {}), null, 2));
    for (const [p, def] of Object.entries(json.paths || {})) {
      console.log(`\n--- PATH: ${p} ---`);
      for (const [method, spec] of Object.entries(def)) {
        console.log(`  ${method.toUpperCase()} summary: ${spec.summary}`);
        const params = spec.parameters || [];
        for (const param of params) {
          console.log(`    param: ${param.name} (${param.in}) required=${param.required} desc=${param.description}`);
        }
      }
    }
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
