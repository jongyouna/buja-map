// 임시 디버그 스크립트: 네이버 부동산 API 도달 가능 여부 및 응답 구조 파악용 (확인 후 삭제 예정)
// fetch 기본 타임아웃이 없어 차단 시 무한 대기하므로 AbortSignal.timeout으로 강제 종료.
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function probe(name, url, extraHeaders = {}) {
  console.log(`\n===== ${name} =====`);
  console.log("URL:", url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": UA,
        Referer: "https://m.land.naver.com/",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9",
        ...extraHeaders,
      },
    });
    const text = await res.text();
    console.log(`status: ${res.status} ${res.headers.get("content-type")} (${Date.now() - started}ms)`);
    console.log("length:", text.length);
    console.log("body (first 1500):", text.slice(0, 1500));
  } catch (e) {
    console.log(`ERROR after ${Date.now() - started}ms:`, e.name, e.message);
  }
}

async function main() {
  // 도달 가능성 기준점: 네이버 메인이 열리는지부터 확인
  await probe("naver.com (연결 가능 여부 기준점)", "https://www.naver.com/");

  // 모바일 클러스터 articleList (인증 불필요로 알려진 엔드포인트) - 서울 대치동 cortarNo 1168010600
  await probe(
    "m.land cluster/ajax/articleList (대치동)",
    "https://m.land.naver.com/cluster/ajax/articleList?itemId=&mapKey=&lgeo=&showR0=&rletTpCd=APT&tradTpCd=A1&z=13&lat=37.4996&lon=127.0629&btm=37.4700&lft=127.0200&top=37.5300&rgt=127.1100&cortarNo=1168010600&page=1&sort=rank"
  );

  await probe("m.land getRegionList (서울 하위 지역)", "https://m.land.naver.com/map/getRegionList?cortarNo=1100000000");

  await probe(
    "new.land regions/complexes",
    "https://new.land.naver.com/api/regions/complexes?cortarNo=1168010600&realEstateType=APT&order=",
    { Referer: "https://new.land.naver.com/" }
  );

  // 대안 후보: 공공데이터 국토부 실거래가는 이미 별도 키가 필요하므로,
  // 네이버가 막히면 어떤 우회 경로가 열려 있는지 함께 확인
  await probe("land.naver.com (구 버전)", "https://land.naver.com/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
