/**
 * GPS Control Center - GitHub Pages + Google Apps Script only
 * Admin UI is served by HtmlService; recipient page is GitHub Pages so
 * browser geolocation is requested from a top-level HTTPS page.
 */
const APP_CONFIG = {
  FRONTEND_URL: 'https://a09848281-prog.github.io/gps-control-center/',
  FRONTEND_ORIGIN: 'https://a09848281-prog.github.io',
  LINKS_SHEET: 'Links',
  LOCATIONS_SHEET: 'Locations',
  LINK_HEADERS: ['ID', 'Slug', 'Message', 'DestinationURL', 'ExpiresAt', 'CreatedAt', 'Active', 'DelaySeconds', 'TrackingEnabled', 'PreviewTitle', 'PreviewDescription', 'PreviewImageURL'],
  LOCATION_HEADERS: ['ID', 'Slug', 'Latitude', 'Longitude', 'AccuracyM', 'CapturedAt']
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = String(params.action || '');
  if (action === 'publicLink') return publicLinkJsonp_(params);
  if (action === 'verifySave') return verifySaveJsonp_(params);
  if (action === 'share') return sharePage_(String(params.slug || '').trim());
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('URL管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  const p = e && e.parameter ? e.parameter : {};
  if (String(p.mode || '') !== 'recordLocation') {
    return ContentService.createTextOutput('Bad request').setMimeType(ContentService.MimeType.TEXT);
  }
  const requestId = String(p.requestId || '');
  try {
    recordLocationPost_(p);
    CacheService.getScriptCache().put('save:' + requestId, JSON.stringify({ ok: true }), 300);
  } catch (error) {
    CacheService.getScriptCache().put('save:' + requestId, JSON.stringify({ ok: false, error: safeError_(error) }), 300);
  }
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/** Run once from the Apps Script editor after setting SETUP_KEY. */
function initializeProject() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SETUP_KEY') && !props.getProperty('SPREADSHEET_ID')) {
    throw new Error('初回初期化にはスクリプトプロパティに SETUP_KEY を登録してください。');
  }
  ensureDatabase_();
  Logger.log('初期化しました。スプレッドシートID: ' + props.getProperty('SPREADSHEET_ID'));
}

function getAdminState() {
  return { setupRequired: !PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD_HASH'), appUrl: ScriptApp.getService().getUrl() || '' };
}

function setupAdmin(setupKey, password) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_PASSWORD_HASH')) throw new Error('管理者パスワードは設定済みです。ログインしてください。');
  const expected = props.getProperty('SETUP_KEY');
  if (!expected || String(setupKey || '') !== expected) throw new Error('セットアップキーが違います。');
  password = String(password || '');
  if (password.length < 10) throw new Error('パスワードは10文字以上にしてください。');
  ensureDatabase_();
  props.setProperty('ADMIN_PASSWORD_HASH', hash_(password));
  props.deleteProperty('SETUP_KEY');
  return { ok: true };
}

function adminLogin(password) {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('ADMIN_PASSWORD_HASH');
  if (!stored) throw new Error('先に管理者パスワードを設定してください。');
  if (hash_(String(password || '')) !== stored) {
    Utilities.sleep(400);
    throw new Error('パスワードが違います。');
  }
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('admin:' + token, '1', 21600);
  return { ok: true, token: token };
}

function adminCheckToken(token) {
  return { ok: isAdmin_(token) };
}

function adminCreateLink(data, token) {
  requireAdmin_(token);
  data = data || {};
  const slug = String(data.slug || '').trim();
  const message = String(data.message || '').trim();
  const destinationUrl = String(data.destinationUrl || '').trim();
  const delaySeconds = Number(data.delaySeconds || 0);
  const trackingEnabled = data.trackingEnabled === true;
  const previewTitle = String(data.previewTitle || message).trim();
  const previewDescription = String(data.previewDescription || message).trim();
  const previewImageURL = String(data.previewImageURL || '').trim();
  if (!previewTitle || previewTitle.length > 100) throw new Error('プレビュータイトルは1〜100文字にしてください。');
  if (!previewDescription || previewDescription.length > 300) throw new Error('プレビュー説明文は1〜300文字にしてください。');
  if (previewImageURL && !isSafeHttpsUrl_(previewImageURL)) throw new Error('プレビュー画像にはHTTPS画像URLを入力してください。');
  if (!/^[A-Za-z0-9_\-\u3040-\u30FF\u3400-\u9FFF]{1,50}$/.test(slug)) {
    throw new Error('URL識別文字は1〜50文字の日本語・英数字・ハイフン・アンダーバーにしてください。');
  }
  if (!message || message.length > 200) throw new Error('表示メッセージは1〜200文字にしてください。');
  if (!isSafeHttpsUrl_(destinationUrl)) throw new Error('リダイレクト先には正しいHTTPS URLを入力してください。');
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 30) throw new Error('待ち時間は0〜30秒にしてください。');
  let expiresAt = '';
  if (data.expiresAt) {
    const parsed = new Date(String(data.expiresAt));
    if (isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) throw new Error('有効期限は未来の日時にしてください。');
    expiresAt = parsed;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_(APP_CONFIG.LINKS_SHEET);
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]) === slug) throw new Error('そのURL識別文字はすでに使われています。');
    }
    const id = Utilities.getUuid();
    const createdAt = new Date();
    sheet.appendRow([id, slug, message, destinationUrl, expiresAt, createdAt, true, delaySeconds, trackingEnabled, previewTitle, previewDescription, previewImageURL]);
    return { ok: true, id: id, slug: slug, url: buildShareUrl_(slug), expiresAt: expiresAt ? iso_(expiresAt) : '' };
  } finally {
    lock.releaseLock();
  }
}

function adminListLinks(token) {
  requireAdmin_(token);
  const rows = getSheet_(APP_CONFIG.LINKS_SHEET).getDataRange().getValues();
  const base = PropertiesService.getScriptProperties().getProperty('FRONTEND_URL') || APP_CONFIG.FRONTEND_URL;
  const separator = base.indexOf('?') >= 0 ? '&' : '?';
  const links = [];
  for (let i = rows.length - 1; i >= 1 && links.length < 500; i--) {
    const r = rows[i];
    links.push({
      id: String(r[0]), slug: String(r[1]), message: String(r[2]), destinationUrl: String(r[3]),
      expiresAt: r[4] instanceof Date ? iso_(r[4]) : '',
      createdAt: r[5] instanceof Date ? iso_(r[5]) : '',
      active: r[6] === true || String(r[6]).toLowerCase() === 'true',
      delaySeconds: Number(r[7] || 0), trackingEnabled: r[8] === true || String(r[8]).toLowerCase() === 'true',
      previewTitle: String(r[9] || r[2] || ''), previewDescription: String(r[10] || r[2] || ''), previewImageURL: String(r[11] || ''),
      url: buildShareUrl_(String(r[1]))
    });
  }
  return { ok: true, links: links };
}

function adminListLocations(token) {
  requireAdmin_(token);
  const rows = getSheet_(APP_CONFIG.LOCATIONS_SHEET).getDataRange().getValues();
  const locations = [];
  for (let i = rows.length - 1; i >= 1 && locations.length < 500; i--) {
    const r = rows[i];
    locations.push({
      id: String(r[0]), slug: String(r[1]), latitude: Number(r[2]), longitude: Number(r[3]),
      accuracy: Number(r[4]), capturedAt: r[5] instanceof Date ? iso_(r[5]) : ''
    });
  }
  return { ok: true, locations: locations };
}

function adminDeactivateLink(id, token) {
  requireAdmin_(token);
  id = String(id || '');
  const sheet = getSheet_(APP_CONFIG.LINKS_SHEET);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      sheet.getRange(i + 1, 7).setValue(false);
      return { ok: true };
    }
  }
  throw new Error('対象URLが見つかりません。');
}

function publicLinkJsonp_(params) {
  const callback = String(params.prefix || '');
  if (!/^[A-Za-z_$][0-9A-Za-z_$]{0,60}$/.test(callback)) return ContentService.createTextOutput('Invalid callback');
  const slug = String(params.slug || '').trim();
  const result = getPublicLink_(slug);
  if (!result.ok) return jsonp_(callback, result);
  const nonce = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('nonce:' + nonce, slug, 1800);
  return jsonp_(callback, {
    ok: true, slug: slug, message: result.link.message, destinationUrl: result.link.destinationUrl,
    destinationHost: hostFromUrl_(result.link.destinationUrl), delaySeconds: result.link.delaySeconds, trackingEnabled: result.link.trackingEnabled, nonce: nonce
  });
}

function verifySaveJsonp_(params) {
  const callback = String(params.prefix || '');
  if (!/^[A-Za-z_$][0-9A-Za-z_$]{0,60}$/.test(callback)) return ContentService.createTextOutput('Invalid callback');
  const requestId = String(params.requestId || '');
  if (!/^[A-Fa-f0-9-]{20,80}$/.test(requestId)) return jsonp_(callback, { ok: false, error: 'Invalid request' });
  const cache = CacheService.getScriptCache();
  const saved = cache.get('save:' + requestId);
  if (!saved) return jsonp_(callback, { ok: false, pending: true });
  cache.remove('save:' + requestId);
  return jsonp_(callback, JSON.parse(saved));
}

function recordLocationPost_(p) {
  const slug = String(p.slug || '');
  const nonce = String(p.nonce || '');
  const requestId = String(p.requestId || '');
  if (!/^[A-Fa-f0-9-]{20,80}$/.test(requestId)) throw new Error('リクエストIDが正しくありません。');
  const cache = CacheService.getScriptCache();
  const expectedSlug = cache.get('nonce:' + nonce);
  if (!expectedSlug || expectedSlug !== slug) throw new Error('この取得リクエストは期限切れです。ページを開き直してください。');
  const latitude = Number(p.latitude);
  const longitude = Number(p.longitude);
  const accuracy = Number(p.accuracy);
  if (!isFinite(latitude) || latitude < -90 || latitude > 90 || !isFinite(longitude) || longitude < -180 || longitude > 180 || !isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
    throw new Error('位置情報の値が正しくありません。');
  }
  const link = getPublicLink_(slug);
  if (!link.ok) throw new Error(link.error);
  if (!link.link.trackingEnabled) cache.remove('nonce:' + nonce);
  getSheet_(APP_CONFIG.LOCATIONS_SHEET).appendRow([Utilities.getUuid(), slug, latitude, longitude, accuracy, new Date()]);
}

function getPublicLink_(slug) {
  if (!slug) return { ok: false, error: 'URLが指定されていません。', code: 'not_found' };
  const rows = getSheet_(APP_CONFIG.LINKS_SHEET).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]) !== slug) continue;
    const active = r[6] === true || String(r[6]).toLowerCase() === 'true';
    if (!active) return { ok: false, error: 'このURLは無効化されています。', code: 'gone' };
    const expiry = r[4] instanceof Date ? r[4] : (r[4] ? new Date(r[4]) : null);
    if (expiry && !isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) return { ok: false, error: 'このURLは有効期限切れです。', code: 'gone' };
    return { ok: true, link: { slug: slug, message: String(r[2]), destinationUrl: String(r[3]), delaySeconds: Number(r[7] || 0), trackingEnabled: r[8] === true || String(r[8]).toLowerCase() === 'true', previewTitle: String(r[9] || r[2] || ''), previewDescription: String(r[10] || r[2] || ''), previewImageURL: String(r[11] || '') } };
  }
  return { ok: false, error: 'このURLは見つかりません。', code: 'not_found' };
}

function buildShareUrl_(slug) {
  const base = ScriptApp.getService().getUrl();
  if (!base) throw new Error('GASウェブアプリをデプロイしてからURLを発行してください。');
  return base + '?action=share&slug=' + encodeURIComponent(slug);
}

function sharePage_(slug) {
  const result = getPublicLink_(slug);
  const template = HtmlService.createTemplateFromFile('Share');
  const valid = result.ok;
  const link = valid ? result.link : null;
  template.previewTitle = valid ? (link.previewTitle || link.message) : '共有リンクを利用できません';
  template.previewDescription = valid ? (link.previewDescription || link.message) : result.error;
  template.previewImageURL = valid ? (link.previewImageURL || '') : '';
  template.shareUrl = buildShareUrl_(slug || '');
  template.redirectUrl = valid ? (APP_CONFIG.FRONTEND_URL + '?slug=' + encodeURIComponent(slug)) : '';
  template.pageMessage = valid ? '共有ページを開いています。自動で切り替わらない場合は、下のリンクを押してください。' : result.error;
  return template.evaluate().setTitle(template.previewTitle).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function ensureDatabase_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  let ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('GPS Control Center - URL管理');
    id = ss.getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  let links = ss.getSheetByName(APP_CONFIG.LINKS_SHEET);
  if (!links) {
    links = ss.getSheets()[0];
    links.setName(APP_CONFIG.LINKS_SHEET);
  }
  if (links.getLastRow() === 0) links.appendRow(APP_CONFIG.LINK_HEADERS);
  let locations = ss.getSheetByName(APP_CONFIG.LOCATIONS_SHEET);
  if (!locations) locations = ss.insertSheet(APP_CONFIG.LOCATIONS_SHEET);
  if (locations.getLastRow() === 0) locations.appendRow(APP_CONFIG.LOCATION_HEADERS);
  if (links.getLastColumn() < APP_CONFIG.LINK_HEADERS.length) links.insertColumnsAfter(links.getLastColumn(), APP_CONFIG.LINK_HEADERS.length - links.getLastColumn());
  links.getRange(1, 1, 1, APP_CONFIG.LINK_HEADERS.length).setValues([APP_CONFIG.LINK_HEADERS]);
  return ss;
}

function getSheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('initializeProject を先に実行してください。');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error('シートが見つかりません: ' + name);
  return sheet;
}

function requireAdmin_(token) {
  if (!isAdmin_(token)) throw new Error('ログイン期限が切れました。もう一度ログインしてください。');
}

function isAdmin_(token) {
  return !!token && CacheService.getScriptCache().get('admin:' + String(token)) === '1';
}

function hash_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function isSafeHttpsUrl_(value) {
  if (!/^https:\/\/[^\s/]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(value)) return false;
  return value.indexOf('@') === -1;
}

function hostFromUrl_(value) {
  const match = String(value).match(/^https:\/\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function iso_(date) {
  return Utilities.formatDate(date, 'GMT', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

function jsonp_(callback, value) {
  const js = callback + '(' + JSON.stringify(value).replace(/</g, '\\u003c') + ');';
  return ContentService.createTextOutput(js).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function safeError_(error) {
  const message = error && error.message ? String(error.message) : 'サーバーエラー';
  return message.slice(0, 240);
}