// 스케줄 워크플로 실패 알림 이메일. self-hosted 러너(집 PC)에서 도는 워크플로가
// 실패했을 때(if: failure()) 호출한다. 급매 알림과 같은 SMTP_URL/SMTP_FROM 시크릿을
// 재사용하며, 시크릿이 없으면 이유를 남기고 조용히 끝낸다(다른 스텝을 막지 않음).
const smtp = process.env.SMTP_URL;
const from = process.env.SMTP_FROM;

async function main() {
  if (!smtp || !from) {
    console.log(
      "[건너뜀] 실패 알림 메일을 보내지 않습니다. " +
        `SMTP_URL=${smtp ? "있음" : "없음"}, SMTP_FROM=${from ? "있음" : "없음"}. ` +
        "docs/bargain-alerts.md 를 참고해 저장소 시크릿을 등록해 주세요."
    );
    return;
  }

  const workflow = process.env.GITHUB_WORKFLOW || "(알 수 없는 워크플로)";
  const context = process.env.NOTIFY_CONTEXT;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

  // NOTIFY_SUBJECT/NOTIFY_MESSAGE가 있으면 우선 사용한다(신선도 체크 등 실패가 아닌
  // 경고성 알림도 같은 메일 발송 로직을 재사용하기 위함). 없으면 기존 실패 알림 문구 그대로.
  const subject = process.env.NOTIFY_SUBJECT || `[buja-map] ${workflow} 실패`;
  const text = [
    process.env.NOTIFY_MESSAGE || `${workflow} 실행이 실패했습니다.`,
    context ? `범위: ${context}` : null,
    `시각: ${new Date().toISOString()}`,
    `로그: ${runUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport(smtp);
  try {
    await transport.sendMail({ from, to: from, subject, text });
    console.log(`[성공] ${from} 로 실패 알림 메일을 발송했습니다.`);
  } catch (err) {
    console.error(`[실패] 실패 알림 메일 발송 오류: ${err.message}`);
  }
}

main();
