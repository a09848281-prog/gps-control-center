/**
 * GPS Control Center - GAS backend
 * 管理者認証・URL情報・許可後の位置情報記録を担当します。
 * 初回設定：スクリプトプロパティに SETUP_KEY を登録し、initializeProject() を実行。
 */
const PROP = PropertiesService.getScriptProperties();
const LINKS_SHEET = "Links";
const LOCATIONS_SHEET = "Locations";
const LINK_HEADERS = ["ID","Slug","Message","DestinationURL","ExpiresAt","CreatedAt","Active","DelaySeconds"];
const LOCATION_HEADERS = ["ID","Slug","Latitude","Longitude","AccuracyM","CapturedAt"];

function initializeProject() {
  ensureSheets_();
  const setupKey = PROP.getProperty("SETUP_KEY");
  if (!PROP.getProperty("ADMIN_PASSWORD_HASH") && !setupKey) {
    throw new Error("先にプロジェクトのスクリプトプロパティへ SETUP_KEY を登録してください。");
  }
  Logger.log("データベースを準備しました。スプレッドシート: " + PROP.getProperty("SPREADSHEET_ID"));
}

function doGet(e) {
  try {
    const action = e && e.parameter ? String(e.parameter.action || "") : "";
    if (action === "health") {
      return json_({ok:true, adminReady:!!PROP.getProperty("ADMIN_PASSWORD_HASH")});
    }
    if (action === "link") {
      const slug = String(e.parameter.slug || "");
      const result = getPublicLink_(slug);
      if (!result.ok) return json_(result);
      return json_({
        ok:true,
        link:{
          slug:result.link.slug,
          message:result.link.message,
          destinationHost:hostFromUrl_(result.link.destinationUrl),
          destinationUrl:result.link.destinationUrl,
          delaySeconds:result.link.delaySeconds
        }
      });
    }
    return json_({ok:false,error:"Not found"});
  } catch (err) {
    return json_({ok:false,error:safeError_(err)});
  }
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const action = String(body.action || "");
    if (action === "setup") return setupAdmin_(body);
    if (action === "login") return login_(body);
    if (action === "collect") return collectLocation_(body);
    if (!isAdmin_(body.token)) return json_({ok:false,error:"管理者認証の有効期限が切れました。再ログインしてください。"});
    if (action === "createLink") return createLink_(body);
    if (action === "listLinks") return listLinks_();
    if (action === "listLocations") return listLocations_();
    if (action === "deactivateLink") return deactivateLink_(body);
    return json_({ok:false,error:"Unknown action"});
  } catch (err) {
    return json_({ok:false,error:safeError_(err)});
  }
}

function setupAdmin_(body) {
  if (PROP.getProperty("ADMIN_PASSWORD_HASH")) return json_({ok:false,error:"管理者パスワードは設定済みです。ログインしてください。"});
  const expected = PROP.getProperty("SETUP_KEY");
  if (!expected || String(body.setupKey || "") !== expected) return json_({ok:false,error:"セットアップキーが違います。"});
  const password = String(body.password || "");
  if (password.length < 10) return json_({ok:false,error:"パスワードは10文字以上にしてください。"});
  ensureSheets_();
  PROP.setProperty("ADMIN_PASSWORD_HASH", hash_(password));
  PROP.deleteProperty("SETUP_KEY");
  return json_({ok:true});
}

function login_(body) {
  const savedHash = PROP.getProperty("ADMIN_PASSWORD_HASH");
  if (!savedHash) return json_({ok:false,error:"初期設定が必要です。"});
  if (hash_(String(body.password || "")) !== savedHash) {
    Utilities.sleep(400);
    return json_({ok:false,error:"パスワードが違います。"});
  }
  const token = Utilities.getUuid().replace(/-/g,"") + Utilities.getUuid().replace(/-/g,"");
  CacheService.getScriptCache().put("admin:" + token, "1", 21600);
  return json_({ok:true,token:token});
}

function isAdmin_(token) {
  if (!token || typeof token !== "string") return false;
  return CacheService.getScriptCache().get("admin:" + token) === "1";
}

function createLink_(body) {
  const slug = String(body.slug || "").trim();
  const message = String(body.message || "").trim();
  const destinationUrl = String(body.destinationUrl || "").trim();
  const expiresRaw = String(body.expiresAt || "").trim();
  const delaySeconds = Number(body.delaySeconds || 0);

  if (!/^[A-Za-z0-9_\-\u3040-\u30FF\u3400-\u9FFF]{1,50}$/.test(slug)) {
    return json_({ok:false,error:"URL識別文字は1〜50文字の日本語・英数字・ハイフン・アンダーバーにしてください。"});
  }
  if (!message || message.length > 200) return json_({ok:false,error:"表示メッセージは1〜200文字で入力してください。"});
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 30) return json_({ok:false,error:"リダイレクト待ち時間は0〜30秒にしてください。"});
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(destinationUrl)) {
    return json_({ok:false,error:"リダイレクト先には正しいHTTPS URLを入力してください。"});
  }
  let expiresAt = "";
  if (expiresRaw) {
    const parsed = new Date(expiresRaw);
    if (isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return json_({ok:false,error:"有効期限は未来の日時にしてください。"});
    }
    expiresAt = parsed;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_(LINKS_SHEET);
    const values = sheet.getDataRange().getValues();
    for (let i=1;i<values.length;i++) {
      if (String(values[i][1]) === slug) return json_({ok:false,error:"そのURL識別文字はすでに使われています。別の文字にしてください。"});
    }
    const id = Utilities.getUuid();
    const createdAt = new Date();
    sheet.appendRow([id,slug,message,destinationUrl,expiresAt,createdAt,true,delaySeconds]);
    return json_({ok:true,link:{id:id,slug:slug,active:true,expiresAt:expiresAt?iso_(expiresAt):"",createdAt:iso_(createdAt)}});
  } finally {
    lock.releaseLock();
  }
}

function listLinks_() {
  const values = getSheet_(LINKS_SHEET).getDataRange().getValues();
  const links = [];
  for (let i=values.length-1;i>=1 && links.length<500;i--) {
    const r = values[i];
    links.push({
      id:String(r[0]),slug:String(r[1]),message:String(r[2]),destinationUrl:String(r[3]),
      expiresAt:r[4] instanceof Date ? iso_(r[4]) : "",createdAt:r[5] instanceof Date ? iso_(r[5]) : "",
      active:r[6] === true || String(r[6]).toLowerCase() === "true",
      delaySeconds:Number(r[7] || 0)
    });
  }
  return json_({ok:true,links:links});
}

function listLocations_() {
  const values = getSheet_(LOCATIONS_SHEET).getDataRange().getValues();
  const locations = [];
  for (let i=values.length-1;i>=1 && locations.length<300;i--) {
    const r = values[i];
    locations.push({
      id:String(r[0]),slug:String(r[1]),latitude:Number(r[2]),longitude:Number(r[3]),
      accuracy:Number(r[4]),capturedAt:r[5] instanceof Date ? iso_(r[5]) : ""
    });
  }
  return json_({ok:true,locations:locations});
}

function deactivateLink_(body) {
  const id = String(body.id || "");
  if (!id) return json_({ok:false,error:"URL IDがありません。"});
  const sheet = getSheet_(LINKS_SHEET);
  const values = sheet.getDataRange().getValues();
  for (let i=1;i<values.length;i++) {
    if (String(values[i][0]) === id) {
      sheet.getRange(i+1,7).setValue(false);
      return json_({ok:true});
    }
  }
  return json_({ok:false,error:"対象URLが見つかりません。"});
}

function collectLocation_(body) {
  const slug = String(body.slug || "");
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  const accuracy = Number(body.accuracy);
  if (!isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
    return json_({ok:false,error:"位置情報の値が正しくありません。"});
  }
  const linkResult = getPublicLink_(slug);
  if (!linkResult.ok) return json_(linkResult);

  const sheet = getSheet_(LOCATIONS_SHEET);
  sheet.appendRow([Utilities.getUuid(),slug,latitude,longitude,accuracy,new Date()]);
  return json_({ok:true});
}

function getPublicLink_(slug) {
  if (!slug) return {ok:false,error:"URLが指定されていません。",code:"not_found"};
  const values = getSheet_(LINKS_SHEET).getDataRange().getValues();
  for (let i=1;i<values.length;i++) {
    const r = values[i];
    if (String(r[1]) !== slug) continue;
    const active = r[6] === true || String(r[6]).toLowerCase() === "true";
    if (!active) return {ok:false,error:"このURLは無効化されています。",code:"gone"};
    const expiry = r[4] instanceof Date ? r[4] : (r[4] ? new Date(r[4]) : null);
    if (expiry && !isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) {
      return {ok:false,error:"このURLは有効期限切れです。",code:"gone"};
    }
    return {ok:true,link:{
      id:String(r[0]),slug:String(r[1]),message:String(r[2]),destinationUrl:String(r[3]),
      expiresAt:expiry,active:true,delaySeconds:Number(r[7] || 0)
    }};
  }
  return {ok:false,error:"このURLは見つかりません。",code:"not_found"};
}

function ensureSheets_() {
  let id = PROP.getProperty("SPREADSHEET_ID");
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create("GPS Control Center - 位置情報管理");
    id = ss.getId();
    PROP.setProperty("SPREADSHEET_ID",id);
  }
  let links = ss.getSheetByName(LINKS_SHEET);
  if (!links) {
    links = ss.getSheets()[0];
    links.setName(LINKS_SHEET);
  }
  if (links.getLastRow() === 0) links.appendRow(LINK_HEADERS);
  if (links.getLastColumn() < LINK_HEADERS.length) links.getRange(1,LINK_HEADERS.length).setValue("DelaySeconds");
  let locations = ss.getSheetByName(LOCATIONS_SHEET);
  if (!locations) locations = ss.insertSheet(LOCATIONS_SHEET);
  if (locations.getLastRow() === 0) locations.appendRow(LOCATION_HEADERS);
  return ss;
}

function getSheet_(name) {
  const ss = ensureSheets_();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("必要なシートが見つかりません: " + name);
  return sheet;
}

function hash_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8);
  return bytes.map(function(b){return ("0"+((b+256)%256).toString(16)).slice(-2);}).join("");
}

function hostFromUrl_(value) {
  const match = String(value).match(/^https:\/\/([^/?#]+)/i);
  return match ? match[1] : "";
}

function iso_(date) {
  return Utilities.formatDate(date,"GMT","yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeError_(err) {
  const message = err && err.message ? String(err.message) : "サーバー内部エラー";
  return message.length > 240 ? message.slice(0,240) : message;
}
