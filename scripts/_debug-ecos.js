// 일회성 디버그: 한국은행 ECOS API에서 M1 통계표·항목 코드 확인. 사용 후 삭제 예정.
// 주의: URL(인증키 포함)은 절대 로그에 출력하지 않음 — 파싱된 JSON 내용만 출력.
const API_KEY = process.env.BOK_ECOS_API_KEY;
if (!API_KEY) {
  console.error("BOK_ECOS_API_KEY 환경변수가 설정되지 않음");
  process.exit(1);
}

async function fetchJson(path) {
  const url = `https://ecos.bok.or.kr/api/${path.replace("{KEY}", API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log(`  (JSON 파싱 실패, status=${res.status}, length=${text.length})`);
    return null;
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let callCount = 0;

async function listChildren(code) {
  callCount++;
  if (callCount > 250) return [];
  const suffix = code ? `/${code}` : "";
  const json = await fetchJson(`StatisticTableList/{KEY}/json/kr/1/100${suffix}`);
  await sleep(80);
  if (!json) return [];
  if (json.RESULT) {
    console.log(`  (code=${code} RESULT: ${JSON.stringify(json.RESULT)})`);
    return [];
  }
  return json.StatisticTableList?.row || [];
}

async function main() {
  console.log("=== 최상위 카테고리 조회 ===");
  const roots = await listChildren("");
  for (const r of roots) {
    console.log(`  STAT_CODE=${r.STAT_CODE}  STAT_NAME=${r.STAT_NAME}  SRCH_YN=${r.SRCH_YN}`);
  }

  const relevant = roots.filter((r) => /통화|금융|유동성/.test(r.STAT_NAME));
  console.log(`\n관련 최상위 카테고리 ${relevant.length}개 발견, 하위 탐색 시작`);

  const found = [];
  async function walk(code, pathLabel, depth) {
    if (depth > 6 || callCount > 250) return;
    const rows = await listChildren(code);
    for (const r of rows) {
      const label = `${r.STAT_CODE} ${r.STAT_NAME} (SRCH_YN=${r.SRCH_YN})`;
      const newPath = pathLabel ? `${pathLabel} > ${label}` : label;
      if (/M1|협의통화/.test(r.STAT_NAME)) {
        console.log("FOUND:", newPath);
        found.push(newPath);
      }
      if (r.SRCH_YN !== "Y") {
        await walk(r.STAT_CODE, newPath, depth + 1);
      } else {
        // 리프 노드도 이름에 힌트가 있을 수 있으니 전체 목록도 남겨둠
        console.log("LEAF:", newPath);
      }
    }
  }

  for (const r of relevant) {
    await walk(r.STAT_CODE, `${r.STAT_CODE} ${r.STAT_NAME}`, 1);
  }

  console.log(`\n총 API 호출 수: ${callCount}`);
  console.log(`\n=== M1/협의통화 매칭 결과 ${found.length}건 ===`);
  for (const f of found) console.log(f);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
