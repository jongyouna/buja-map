/**
 * buja-map 문의 메일 발송기 (Google Apps Script 웹앱)
 *
 * 사이트는 정적 파일이라 브라우저에서 메일을 바로 보낼 수 없다. 이 스크립트를 관리자
 * 구글 계정에 웹앱으로 배포해 두면, 문의창이 여기로 내용을 넘기고 이 스크립트가
 * MailApp으로 관리자 메일함에 넣는다.
 *
 * 배포 절차와 설정값은 docs/inquiry-setup.md 참고. 이 파일은 저장소에 보관하는 원본이고,
 * 실제로 도는 코드는 Apps Script 편집기에 붙여넣은 사본이다. 여기를 고쳤으면 편집기에도
 * 붙여넣고 "새 버전으로 배포"까지 해야 반영된다.
 */

// ---- 설정 ----

// 문의를 받을 주소.
var ADMIN_EMAIL = 'jongyouna@gmail.com';

// Firebase 웹 API 키. index.html의 firebaseConfig.apiKey와 같은 값이며, 원래 공개되는 값이다.
// 이 키는 "토큰이 이 프로젝트의 것인지" 확인하는 용도로만 쓴다.
//
// 반드시 'AIza...'로 시작하는 apiKey 값이어야 한다.
// 바로 아래 줄에 있는 authDomain('...firebaseapp.com')과 헷갈리기 쉬우니 주의.
var FIREBASE_API_KEY = 'PASTE_FIREBASE_WEB_API_KEY';

// 한 사람이 연달아 보낼 수 있는 간격(초)과 하루 총 발송 한도.
// Gmail 무료 계정의 MailApp 한도가 하루 100통이므로 그보다 낮게 잡는다.
var SENDER_COOLDOWN_SEC = 60;
var SENDER_DAILY_LIMIT = 10;
var TOTAL_DAILY_LIMIT = 50;

var MAX_MESSAGE_LEN = 500;

// ---- 웹앱 진입점 ----

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    var message = String(body.message == null ? '' : body.message).trim();
    if (!message) return fail('문의 내용이 비어 있습니다.');
    if (message.length > MAX_MESSAGE_LEN) {
      return fail(MAX_MESSAGE_LEN + '자 이내로 줄여 주세요.');
    }

    // 웹앱 URL은 사이트 소스에 그대로 들어 있어 누구나 호출할 수 있다. 그래서 여기서
    // Firebase ID 토큰을 검증해 실제 로그인한 사용자가 보낸 것만 통과시킨다.
    var sender = verifyIdToken(body.idToken);
    if (!sender) return fail('로그인 정보가 확인되지 않았습니다. 다시 로그인한 뒤 시도해 주세요.');

    var limited = checkRateLimit(sender.email);
    if (limited) return fail(limited);

    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      // 메일함에서 바로 "답장"을 누르면 문의한 사람에게 가도록 한다.
      replyTo: sender.email,
      subject: '[buja-map 문의] ' + (sender.name || sender.email),
      body: [
        '보낸 사람: ' + (sender.name || '(이름 없음)') + ' <' + sender.email + '>',
        '보낸 시각: ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        '보낸 화면: ' + String(body.page || ''),
        '',
        '---- 문의 내용 ----',
        message,
      ].join('\n'),
    });

    return ok();
  } catch (err) {
    // 예외 내용을 그대로 돌려주면 내부 사정이 노출되므로 로그에만 남긴다.
    console.error(err);
    return fail('메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

// 배포가 살아 있는지 브라우저로 확인할 때 쓴다.
function doGet() {
  return json({ ok: true, service: 'buja-map inquiry mailer' });
}

// ---- 사용자 검증 ----

/**
 * Firebase ID 토큰을 Identity Toolkit에 물어 확인한다.
 * 유효하면 { email, name }, 아니면 null.
 */
function verifyIdToken(idToken) {
  if (!idToken) return null;
  // 설정을 빠뜨렸거나 authDomain을 잘못 넣으면 아래 요청이 그냥 400으로 떨어져서
  // "로그인 정보가 확인되지 않았습니다"로만 보인다. 실행 로그에 원인을 남겨 둔다.
  if (FIREBASE_API_KEY.indexOf('AIza') !== 0) {
    console.error(
      'FIREBASE_API_KEY 설정이 잘못됐습니다. index.html의 firebaseConfig.apiKey("AIza...")를 넣어야 합니다. ' +
        '지금 값: ' + FIREBASE_API_KEY
    );
    return null;
  }
  var url =
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
    encodeURIComponent(FIREBASE_API_KEY);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.warn('ID 토큰 확인 실패: ' + res.getResponseCode() + ' ' + res.getContentText());
    return null;
  }
  var user = (JSON.parse(res.getContentText()).users || [])[0];
  // 구글 로그인만 쓰므로 이메일은 항상 검증된 값이지만, 한 번 더 확인한다.
  if (!user || !user.email || user.emailVerified !== true) return null;
  return { email: user.email, name: user.displayName || '' };
}

// ---- 발송 한도 ----

/**
 * 막아야 하면 사용자에게 보여 줄 문구를, 통과면 null을 돌려준다.
 * 사람별 한도는 캐시(최대 6시간)로, 전체 한도는 스크립트 속성으로 센다.
 */
function checkRateLimit(email) {
  var cache = CacheService.getScriptCache();
  var key = 'inq:' + Utilities.base64EncodeWebSafe(email);

  if (cache.get(key + ':cool')) {
    return '방금 문의를 보내셨습니다. 잠시 후 다시 시도해 주세요.';
  }

  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var mineKey = key + ':' + today;
  var mine = Number(cache.get(mineKey) || 0);
  if (mine >= SENDER_DAILY_LIMIT) {
    return '오늘 보낼 수 있는 문의 수를 넘었습니다. 내일 다시 시도해 주세요.';
  }

  var props = PropertiesService.getScriptProperties();
  var totalKey = 'total:' + today;
  var total = Number(props.getProperty(totalKey) || 0);
  if (total >= TOTAL_DAILY_LIMIT) {
    return '오늘 접수 가능한 문의가 모두 찼습니다. 내일 다시 시도해 주세요.';
  }

  cache.put(key + ':cool', '1', SENDER_COOLDOWN_SEC);
  cache.put(mineKey, String(mine + 1), 6 * 60 * 60);
  props.setProperty(totalKey, String(total + 1));
  // 날짜가 바뀌면 지난 날짜 키는 쓸모없으므로 정리한다.
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('total:') === 0 && k !== totalKey) props.deleteProperty(k);
  });
  return null;
}

// ---- 응답 ----

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function ok() {
  return json({ ok: true });
}

function fail(reason) {
  // 실패도 HTTP 200 + {ok:false}로 돌려준다. Apps Script가 오류 상태로 응답하면
  // 브라우저에는 CORS 헤더 없는 HTML 오류 페이지가 와서 원인을 읽을 수 없다.
  return json({ ok: false, error: reason });
}
