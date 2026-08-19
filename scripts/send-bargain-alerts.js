// 급매 알림 이메일 발송.
//
// data/naver-land.json(수집 결과)과 Firestore의 사용자별 알림 설정을 맞춰 보고,
// 조건에 드는 급매가 있으면 그 사용자의 계정 이메일로 목록을 보낸다.
//
// 왜 브라우저가 아니라 여기서 보내는가:
// 정적 페이지에서는 메일을 보낼 수 없고, Firestore만으로도 보낼 수 없다. 매물 수집을
// 이미 자체 러너에서 돌리고 있으므로 발송도 같은 자리에서 처리한다.
//
// 실행에 필요한 것(둘 다 GitHub Actions 시크릿):
//   FIREBASE_SERVICE_ACCOUNT  Firebase 콘솔 > 프로젝트 설정 > 서비스 계정에서 받은 JSON 전체
//   SMTP_URL                  smtps://아이디:앱비밀번호@smtp.gmail.com:465 형식
//                             (Gmail은 2단계 인증 후 "앱 비밀번호"를 발급해 써야 한다)
// 하나라도 없으면 아무것도 보내지 않고 이유를 남기고 끝낸다. 조용히 실패하지 않는다.
//
// 보내기 전 확인만 하고 싶으면 DRY_RUN=1 로 실행한다. 받는 사람과 건수만 찍는다.
const fs = require("fs");
const path = require("path");

const PYEONG_M2 = 3.305785;
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_ROWS_PER_MAIL = 50; // 메일이 끝없이 길어지지 않도록

function readData() {
  const p = path.join(__dirname, "..", "data", "naver-land.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  return { regions: parsed.regions || [], updatedAt: parsed.updatedAt || null };
}

// 화면(index.html)의 칩 판정과 같은 규칙. 동 칩은 매물 주소의 동을 본다.
function matchesChip(region, row, c) {
  if (region.si !== c.si) return false;
  if (c.level === "si") return true;
  if (region.gugun !== c.gugun) return false;
  if (c.level === "gugun") return true;
  return (row.dong || region.dong) === c.dong;
}

function rowArea(c) {
  return c.exclusiveArea ?? c.supplyArea ?? c.avgArea ?? null;
}

function pyeongAskMin(c) {
  if (c.pyeongAskMin != null) return c.pyeongAskMin;
  const supply = c.supplyArea ?? c.avgArea ?? null;
  if (c.minPrice == null || supply == null) return null;
  return Math.round(c.minPrice / (supply / PYEONG_M2));
}

const fmtEok = (manwon) => (manwon == null ? "–" : `${(manwon / 10000).toFixed(1)}억`);

// 사용자가 저장해 둔 필터로 급매만 골라낸다.
function pickBargains(regions, f) {
  const include = Array.isArray(f.include) ? f.include : [];
  const exclude = Array.isArray(f.exclude) ? f.exclude : [];
  if (include.length === 0) return [];
  const pct = Number(f.bargainPct) > 0 ? Number(f.bargainPct) : 5;
  const trade = f.trade || "A1";
  const minDeals = f.dealCount ? Number(f.dealCount) : null;
  // 단지 전체 세대수 하한. 화면의 "세대수" 드롭다운과 같은 기준.
  const minHouseholds = f.household ? Number(f.household) : null;
  const out = [];
  // 흑석동처럼 구 지역과 동 지역에 같은 단지가 함께 들어 있어, 화면과 똑같이
  // (단지 × 면적)으로 한 번만 센다. 안 그러면 메일에 같은 줄이 두 번 실린다.
  const seen = new Set();

  for (const region of regions) {
    for (const c of region.complexes) {
      if (c.tradeType !== trade) continue;
      if (!include.some((chip) => matchesChip(region, c, chip))) continue;
      if (exclude.some((chip) => matchesChip(region, c, chip))) continue;

      const area = rowArea(c);
      if (f.pyeongMin != null || f.pyeongMax != null) {
        const lo = Number(f.pyeongMin) || 0;
        const hi = Number(f.pyeongMax);
        const openTop = !Number.isFinite(hi) || hi >= 60;
        if (!(lo === 0 && openTop)) {
          if (area == null) continue;
          const py = area / PYEONG_M2;
          if (py < lo) continue;
          if (!openTop && py >= hi) continue;
        }
      }

      const priceMin = (Number(f.priceMin) || 0) * 10000;
      const priceMaxStep = Number(f.priceMax);
      const priceMax = !Number.isFinite(priceMaxStep) || priceMaxStep >= 50 ? Infinity : priceMaxStep * 10000;
      if (c.minPrice == null) continue;
      if (c.minPrice < priceMin || c.minPrice > priceMax) continue;

      if (f.age) {
        if (c.approvalElapsedYear == null) continue;
        if (f.age === "20+" ? c.approvalElapsedYear <= 20 : c.approvalElapsedYear > Number(f.age)) continue;
      }
      if (minDeals != null && c.count < minDeals) continue;
      if (minHouseholds != null) {
        if (c.householdCount == null) continue;
        if (c.householdCount < minHouseholds) continue;
      }

      if (!(c.realMaxPrice > 0)) continue;
      const off = ((c.realMaxPrice - c.minPrice) / c.realMaxPrice) * 100;
      if (off < pct) continue;

      const key = `${c.complexNo ?? c.complexName}|${area == null ? "" : area.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        region: [region.si ? `${region.si}시` : null, region.gugun, c.dong || region.dong].filter(Boolean).join(" "),
        name: c.complexName,
        area,
        minPrice: c.minPrice,
        realMaxPrice: c.realMaxPrice,
        off,
        count: c.count,
        pyeongAsk: pyeongAskMin(c),
        complexNo: c.complexNo,
      });
    }
  }
  // 여기서는 "많이 빠진 순"으로만 세운다. 메일 한 통에 50줄까지만 싣기 때문에
  // 이 순서가 곧 무엇을 실을지 고르는 기준이 된다(= 가장 많이 빠진 50건).
  // 실제로 표에 늘어놓는 순서는 아래 sortForMail 이 따로 정한다.
  // 같은 단지의 다른 평형이 여러 줄 나올 수 있다.
  out.sort((a, b) => b.off - a.off);
  return out;
}

// 메일 표에 늘어놓을 순서: 최저가 오름차순(같으면 많이 빠진 순).
// 고르는 기준(하락률)과 늘어놓는 기준(가격)을 나눠 둬야, 값싼 매물 50건만 실리고
// 정작 크게 빠진 매물이 잘려 나가는 일이 없다.
function sortForMail(rows) {
  return rows.slice().sort((a, b) => a.minPrice - b.minPrice || b.off - a.off);
}

function getKstDate(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return {
    y,
    m,
    d,
    dateStr: `${y}.${m}.${d}`,
    dateKoStr: `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`,
  };
}

function buildSubject(count, date = new Date()) {
  const { dateStr } = getKstDate(date);
  return `[buja-map] ${dateStr} 급매 ${count}건`;
}

function buildHtml(rows, f, updatedAt, total) {
  const { dateKoStr } = getKstDate();
  const maxOff = rows.reduce((max, r) => (r.off > max ? r.off : max), 0);
  const minAskPrice = rows.reduce((min, r) => (min === null || r.minPrice < min ? r.minPrice : min), null);
  const includeLabel = (f.include || []).map((c) => c.label).join(", ") || "전체 지역";
  const updatedStr = updatedAt
    ? new Date(updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
    : "최근 수집 데이터";

  const tableRows = rows
    .map((r, idx) => {
      const bg = idx % 2 === 1 ? "background-color:#141b2d;" : "background-color:#0f172a;";
      const link = r.complexNo
        ? `<a href="https://fin.land.naver.com/complexes/${r.complexNo}?tab=article" style="color:#60a5fa;text-decoration:none;font-weight:600;" target="_blank">${r.name} ↗</a>`
        : `<span style="color:#f8fafc;font-weight:600;">${r.name}</span>`;
      return `
        <tr style="${bg}border-bottom:1px solid #1e293b;">
          <td style="padding:10px 12px;color:#94a3b8;font-size:12px;white-space:nowrap;">${r.region}</td>
          <td style="padding:10px 12px;font-size:13px;">${link}</td>
          <td style="padding:10px 10px;text-align:right;color:#cbd5e1;font-size:12px;white-space:nowrap;">${r.area == null ? "–" : `${r.area.toFixed(1)}㎡`}</td>
          <td style="padding:10px 10px;text-align:right;color:#ffffff;font-size:13px;font-weight:700;white-space:nowrap;">${fmtEok(r.minPrice)}</td>
          <td style="padding:10px 10px;text-align:right;color:#64748b;font-size:12px;white-space:nowrap;">${fmtEok(r.realMaxPrice)}</td>
          <td style="padding:10px 10px;text-align:center;white-space:nowrap;">
            <span style="display:inline-block;padding:3px 8px;border-radius:9999px;background-color:rgba(244,63,94,0.15);border:1px solid rgba(244,63,94,0.35);color:#fb7185;font-size:11px;font-weight:800;">-${r.off.toFixed(1)}%</span>
          </td>
          <td style="padding:10px 10px;text-align:center;color:#94a3b8;font-size:12px;white-space:nowrap;">${r.count}건</td>
        </tr>`;
    })
    .join("");

  const moreNotice =
    total > rows.length
      ? `<div style="padding:14px 20px;background-color:#162032;text-align:center;color:#94a3b8;font-size:12px;border-top:1px solid #1e293b;">
          이 밖에 <strong style="color:#f8fafc;">${total - rows.length}건</strong>의 급매물이 더 있습니다.
        </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${buildSubject(total)}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#07090e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Pretendard',sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:660px;margin:0 auto;background-color:#0f172a;border-radius:18px;border:1px solid #1e293b;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);">
    
    <!-- Supernova Cosmic Glow Accent Bar -->
    <div style="height:4px;background:linear-gradient(90deg, #6366f1 0%, #ec4899 50%, #f59e0b 100%);"></div>

    <!-- Header Section -->
    <div style="padding:28px 24px 20px;background:linear-gradient(180deg, rgba(30,41,59,0.7) 0%, rgba(15,23,42,0.3) 100%);border-bottom:1px solid #1e293b;">
      <div style="display:inline-block;padding:4px 12px;border-radius:9999px;background-color:rgba(99,102,241,0.15);border:1px solid rgba(129,140,248,0.35);color:#a5b4fc;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px;">
        BUJA-MAP · SUPERNOVA ALERT
      </div>
      <h1 style="margin:0 0 6px;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.02em;line-height:1.3;">
        ⚡ 실시간 급매 브리핑 <span style="color:#38bdf8;">(${total}건)</span>
      </h1>
      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;">
        ${dateKoStr} · 실거래 최고가 대비 급매 포착 내역입니다.
      </p>
    </div>

    <!-- Summary Metrics 3-Grid -->
    <div style="padding:16px 20px 8px;">
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0;" role="presentation">
        <tr>
          <td style="width:33.33%;background-color:#162032;border:1px solid #1e293b;border-radius:12px;padding:12px 14px;text-align:center;">
            <div style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:0.02em;">총 급매물</div>
            <div style="color:#38bdf8;font-size:20px;font-weight:800;margin-top:2px;">${total}건</div>
          </td>
          <td style="width:33.33%;background-color:#162032;border:1px solid #1e293b;border-radius:12px;padding:12px 14px;text-align:center;">
            <div style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:0.02em;">최고 하락률</div>
            <div style="color:#fb7185;font-size:20px;font-weight:800;margin-top:2px;">-${maxOff.toFixed(1)}%</div>
          </td>
          <td style="width:33.33%;background-color:#162032;border:1px solid #1e293b;border-radius:12px;padding:12px 14px;text-align:center;">
            <div style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:0.02em;">최저 호가</div>
            <div style="color:#a78bfa;font-size:20px;font-weight:800;margin-top:2px;">${fmtEok(minAskPrice)}</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Filter Conditions Banner -->
    <div style="margin:8px 24px 16px;padding:12px 16px;background-color:#162032;border-radius:10px;border-left:3px solid #6366f1;color:#cbd5e1;font-size:12px;line-height:1.6;">
      <div><strong style="color:#ffffff;">알림 조건:</strong> 지역 <span style="color:#93c5fd;font-weight:600;">${includeLabel}</span> · 실거래 최고가 대비 <span style="color:#fca5a5;font-weight:600;">${f.bargainPct || 5}% 이상 하락</span></div>
      <div style="color:#64748b;font-size:11px;margin-top:2px;">데이터 수집 기준: ${updatedStr}</div>
    </div>

    <!-- Bargain Table -->
    <div style="padding:0 24px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left;" role="table">
        <thead>
          <tr style="background-color:#1e293b;border-bottom:2px solid #334155;">
            <th style="padding:10px 12px;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">지역</th>
            <th style="padding:10px 12px;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">단지명</th>
            <th style="padding:10px 10px;text-align:right;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">전용</th>
            <th style="padding:10px 10px;text-align:right;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">최저가</th>
            <th style="padding:10px 10px;text-align:right;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">실거래최고</th>
            <th style="padding:10px 10px;text-align:center;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">하락률</th>
            <th style="padding:10px 10px;text-align:center;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">매물</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
    ${moreNotice}

    <!-- CTA Button Section -->
    <div style="padding:24px;text-align:center;background-color:#0b0f19;border-top:1px solid #1e293b;">
      <a href="https://buja-map.web.app" style="display:inline-block;padding:12px 30px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%);color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;border-radius:10px;box-shadow:0 4px 14px rgba(99,102,241,0.4);" target="_blank">
        buja-map에서 실시간 급매 확인하기 →
      </a>
    </div>

    <!-- Footer -->
    <div style="padding:18px 24px 24px;text-align:center;color:#64748b;font-size:11px;line-height:1.6;background-color:#07090e;border-top:1px solid #141b2d;">
      이 메일은 buja-map에서 직접 신청하신 급매 알림입니다.<br/>
      알림 조건 변경 및 해제는 buja-map &gt; <strong>급매 Now!</strong> 탭의 <strong>🔔 급매 알림</strong>에서 가능합니다.<br/>
      <span style="display:inline-block;margin-top:6px;color:#475569;">© 2026 buja-map · 자산관리 대시보드</span>
    </div>

  </div>
</body>
</html>`;
}

function shouldSendToday(frequency) {
  if (frequency !== "weekly") return true;
  // 주 1회는 월요일에만 보낸다(한국 시간 기준).
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.getUTCDay() === 1;
}

async function main() {
  const args = process.argv.slice(2);
  const targetEmailArg = args.find((a) => a.startsWith("--to="))?.split("=")[1] || process.env.TEST_TO;
  const isPreviewOnly = args.includes("--preview");

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  const smtp = process.env.SMTP_URL;

  const { regions, updatedAt } = readData();

  // 특정 사용자(예: --to=jongyouna@gmail.com)에게만 테스트 발송 또는 프리뷰 모드
  if (targetEmailArg || isPreviewOnly) {
    const to = targetEmailArg || "jongyouna@gmail.com";
    console.log(`[테스트 모드] 대상 이메일: ${to}`);

    // 기본 강남/주요 지역 또는 전체 지역 기준 급매물 추출 (기본 5% 이상 하락)
    const testFilter = {
      include: [{ si: "서울", gugun: "강남구", level: "gugun", label: "강남구" }],
      bargainPct: 5,
    };
    const rows = pickBargains(regions, testFilter);
    const sorted = sortForMail(rows.slice(0, MAX_ROWS_PER_MAIL));
    const subject = buildSubject(rows.length);
    const html = buildHtml(sorted, testFilter, updatedAt, rows.length);

    // 프리뷰 파일 저장
    const previewPath = path.join(__dirname, "..", "preview-bargain-email.html");
    fs.writeFileSync(previewPath, html, "utf8");
    console.log(`  [프리뷰 저장 완료] ${previewPath}`);
    console.log(`  제목: ${subject}`);
    console.log(`  급매물 건수: ${rows.length}건 (표 표시: ${sorted.length}건)`);

    if (isPreviewOnly) {
      return;
    }

    if (!smtp) {
      console.log(`  [안내] SMTP_URL 환경변수가 없어 실제 메일 전송은 건너뜁니다. (프리뷰 HTML 생성 완료)`);
      if (DRY_RUN) {
        console.log(`  [연습] ${to} <- ${subject}`);
      }
      return;
    }

    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport(smtp);
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM || to,
        to,
        subject,
        html,
      });
      console.log(`  [성공] ${to} 로 테스트 메일을 성공적으로 발송했습니다!`);
    } catch (err) {
      console.error(`  [실패] ${to} 발송 오류: ${err.message}`);
    }
    return;
  }

  if (!sa || !smtp) {
    console.error(
      "[건너뜀] 발송에 필요한 시크릿이 없습니다. " +
        `FIREBASE_SERVICE_ACCOUNT=${sa ? "있음" : "없음"}, SMTP_URL=${smtp ? "있음" : "없음"}. ` +
        "docs/bargain-alerts.md 를 참고해 저장소 시크릿을 등록해 주세요."
    );
    return;
  }

  // firebase-admin은 버전마다 루트 export가 다르다(v11은 admin.credential.cert,
  // v14는 admin.cert). 어느 쪽이든 있는 서브패스 진입점을 쓴다.
  const { initializeApp, cert } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const nodemailer = require("nodemailer");
  initializeApp({ credential: cert(JSON.parse(sa)) });
  const db = getFirestore();

  const snap = await db.collection("users").get();
  const transport = nodemailer.createTransport(smtp);

  let sent = 0;
  let skipped = 0;
  for (const docSnap of snap.docs) {
    const u = docSnap.data();
    const alert = u.bargainAlert;
    if (!alert?.enabled) continue;
    if (u.alertsAllowed === false) {
      console.log(`  건너뜀(관리자 차단): ${u.email}`);
      skipped++;
      continue;
    }
    if (u.blocked) {
      skipped++;
      continue;
    }
    if (!shouldSendToday(alert.frequency)) continue;
    const to = alert.email || u.email;
    if (!to) continue;

    const rows = pickBargains(regions, alert.filters || {});
    if (rows.length === 0) {
      console.log(`  보낼 것 없음: ${to}`);
      continue;
    }
    const html = buildHtml(sortForMail(rows.slice(0, MAX_ROWS_PER_MAIL)), alert.filters || {}, updatedAt, rows.length);
    const subject = buildSubject(rows.length);
    if (DRY_RUN) {
      console.log(`  [연습] ${to} <- ${subject}`);
      sent++;
      continue;
    }
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM || to,
        to,
        subject,
        html,
      });
      await docSnap.ref.set(
        { bargainAlert: { ...alert, lastSentAt: new Date().toISOString(), lastSentCount: rows.length } },
        { merge: true }
      );
      console.log(`  보냄: ${to} (${rows.length}건, ${subject})`);
      sent++;
    } catch (err) {
      console.error(`  실패: ${to} — ${err.message}`);
    }
  }
  console.log(`[완료] 발송 ${sent}건 / 건너뜀 ${skipped}건${DRY_RUN ? " (연습 실행)" : ""}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  readData,
  pickBargains,
  sortForMail,
  buildHtml,
  buildSubject,
  getKstDate,
  main,
};
