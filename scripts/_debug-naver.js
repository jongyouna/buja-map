// 임시 디버그 스크립트: 네이버 부동산 API 응답 구조 파악용 (확인 후 삭제 예정)
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function probe(name, url, extraHeaders = {}) {
  console.log(`\n===== ${name} =====`);
  console.log("URL:", url);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://m.land.naver.com/",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9",
        ...extraHeaders,
      },
    });
    console.log("status:", res.status, res.headers.get("content-type"));
    const text = await res.text();
    console.log("length:", text.length);
    console.log("body (first 2500):", text.slice(0, 2500));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

async function main() {
  // 1) 모바일 클러스터 articleList (인증 불필요로 알려진 엔드포인트)
  // 서울 강남구 대치동 = cortarNo 1168010600
  await probe(
    "m.land cluster/ajax/articleList (대치동)",
    "https://m.land.naver.com/cluster/ajax/articleList?itemId=&mapKey=&lgeo=&showR0=&rletTpCd=APT&tradTpCd=A1&z=13&lat=37.4996&lon=127.0629&btm=37.4700&lft=127.0200&top=37.5300&rgt=127.1100&cortarNo=1168010600&page=1&sort=rank"
  );

  // 2) 지역 코드 조회 API
  await probe(
    "m.land regionList (서울 하위 지역)",
    "https://m.land.naver.com/map/getRegionList?cortarNo=1100000000"
  );

  // 3) 단지 목록 (complexList)
  await probe(
    "m.land complex list (대치동)",
    "https://m.land.naver.com/complex/ajax/complexListByCortarNo?cortarNo=1168010600"
  );

  // 4) new.land API (인증 토큰 필요할 수 있음 - 확인용)
  await probe(
    "new.land regions/complexes",
    "https://new.land.naver.com/api/regions/complexes?cortarNo=1168010600&realEstateType=APT&order=",
    { Referer: "https://new.land.naver.com/" }
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
