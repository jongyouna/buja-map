// 일회성 디버그: data.go.kr 15111714(한국부동산원_주택공급정보_입주예정물량정보) API 스펙 확인. 사용 후 삭제 예정.
async function main() {
  const urls = [
    "https://www.data.go.kr/data/15111714/openapi.do",
    "https://www.data.go.kr/data/15111714/fileData.do",
  ];
  for (const url of urls) {
    console.log(`\n=== ${url} ===`);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
      const text = await res.text();
      console.log(`  status=${res.status} length=${text.length}`);
      // Endpoint/요청 URL 관련 힌트 추출
      const hints = [];
      const patterns = [
        /https?:\/\/apis\.data\.go\.kr\/[^\s"'<>]+/g,
        /https?:\/\/openapi\.reb\.or\.kr[^\s"'<>]*/g,
        /End ?[Pp]oint[^<\n]{0,200}/g,
        /요청\s*URL[^<\n]{0,200}/g,
        /"?endpoint"?\s*[:=]\s*"[^"]+"/g,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) hints.push(...m);
      }
      console.log("  hints:", JSON.stringify([...new Set(hints)].slice(0, 20), null, 2));
    } catch (e) {
      console.log("  ERROR:", e.message);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
