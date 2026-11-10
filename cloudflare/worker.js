/**
 * GPS Control Center - Cloudflare Worker
 *
 * 役割:
 * - 管理画面からのAPIをGASへ中継
 * - /r/{slug} で説明を表示し、ブラウザ許可後に位置情報を送信
 * - /go/{slug} でHTTP 301を返す
 *
 * デプロイ前に GAS_URL と FRONTEND_ORIGIN を設定してください。
 */
const GAS_URL = "PASTE_GAS_WEB_APP_EXEC_URL_HERE";
const FRONTEND_ORIGIN = "https://a09848281-prog.github.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("Origin") || "";

    if (path === "/health" && request.method === "GET") {
      try {
        const result = await gasGet({action:"health"});
        return jsonResponse(result, 200, origin, url.origin);
      } catch (error) {
        return jsonResponse({ok:false,error:"GASへの接続に失敗しました。WorkerのGAS_URLを確認してください。"}, 502, origin, url.origin);
      }
    }

    if (path.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return preflightResponse(origin, url.origin);
      }
      if (request.method !== "POST") {
        return jsonResponse({ok:false,error:"POST only"},405,origin,url.origin);
      }
      const action = path.slice("/api/".length);
      const allowed = ["setup","login","createLink","listLinks","listLocations","deactivateLink","collect"];
      if (!allowed.includes(action)) return jsonResponse({ok:false,error:"Unknown API"},404,origin,url.origin);

      const expectedOrigin = action === "collect" ? url.origin : FRONTEND_ORIGIN;
      if (origin && origin !== expectedOrigin) {
        return jsonResponse({ok:false,error:"Origin is not allowed."},403,origin,url.origin);
      }
      try {
        const body = await request.json();
        body.action = action;
        const result = await gasPost(body);
        return jsonResponse(result, result.ok ? 200 : 400, origin, url.origin);
      } catch (error) {
        return jsonResponse({ok:false,error:"GASとの通信に失敗しました。GASをWebアプリとして公開し、GAS_URLを確認してください。"},502,origin,url.origin);
      }
    }

    if (path.startsWith("/r/") && request.method === "GET") {
      const slug = decodePathPart(path.slice(3));
      if (!slug) return textResponse("URLが正しくありません。",404);
      const result = await getLink(slug);
      if (!result.ok) return textResponse(result.error || "このURLは利用できません。", result.code === "gone" ? 410 : 404);
      return consentPage(url.origin, slug, result.link);
    }

    if (path.startsWith("/go/") && request.method === "GET") {
      const slug = decodePathPart(path.slice(4));
      if (!slug) return textResponse("URLが正しくありません。",404);
      const result = await getLink(slug);
      if (!result.ok) return textResponse(result.error || "このURLは利用できません。", result.code === "gone" ? 410 : 404);
      const target = result.link.destinationUrl;
      if (!isSafeHttpsUrl(target)) return textResponse("転送先URLが正しくありません。",500);
      // 本物のHTTP 301。URLの無効化・期限切れを確認し続けるため、キャッシュは禁止する。
      return new Response(null, {
        status: 301,
        headers: {
          "Location": target,
          "Cache-Control": "no-store, private, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    return textResponse("Not Found",404);
  }
};

async function gasGet(params) {
  if (GAS_URL.indexOf("PASTE_") === 0) throw new Error("GAS_URL is not configured");
  const endpoint = new URL(GAS_URL);
  Object.keys(params).forEach(key => endpoint.searchParams.set(key,String(params[key])));
  const response = await fetch(endpoint.toString(), {method:"GET",redirect:"follow"});
  if (!response.ok) throw new Error("GAS HTTP " + response.status);
  return await response.json();
}

async function gasPost(body) {
  if (GAS_URL.indexOf("PASTE_") === 0) throw new Error("GAS_URL is not configured");
  const response = await fetch(GAS_URL, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body),
    redirect:"follow"
  });
  if (!response.ok) throw new Error("GAS HTTP " + response.status);
  return await response.json();
}

async function getLink(slug) {
  try {
    const result = await gasGet({action:"link",slug:slug});
    if (!result.ok) return result;
    return {ok:true,link:result.link};
  } catch (error) {
    return {ok:false,error:"URL情報を確認できません。管理者に連絡してください。",code:"error"};
  }
}

function consentPage(workerOrigin, slug, link) {
  const safeMessage = escapeHtml(link.message || "");
  const destinationHost = escapeHtml(link.destinationHost || "指定されたサイト");
  const slugLiteral = JSON.stringify(slug).replace(/</g,"\\u003c");
  const delay = Math.max(0,Math.min(30,Number(link.delaySeconds)||0));
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>位置情報の確認</title>' +
    '<style>body{margin:24px;background:#fff;color:#111;font:16px/1.8 system-ui,-apple-system,sans-serif;white-space:normal}#message{white-space:pre-wrap}p{margin:0 0 16px}#state{margin-top:18px}</style></head><body>' +
    '<p id="message">' + safeMessage + '</p>' +
    '<p>続行すると、ブラウザで許可した場合に限り、現在地（緯度・経度・精度）が管理者に送信されます。取得後、' + destinationHost + ' へ移動します。</p>' +
    '<p id="state" role="status" aria-live="polite">ブラウザの位置情報許可を確認しています。</p>' +
    '<script>(function(){' +
    'const slug=' + slugLiteral + ';' +
    'const state=document.getElementById("state");' +
    'if(!navigator.geolocation){state.textContent="このブラウザは位置情報に対応していません。位置情報は送信されていません。";return;}' +
    'navigator.geolocation.getCurrentPosition(async function(position){' +
      'state.textContent="位置情報を送信しています。";' +
      'try{' +
        'const c=position.coords;' +
        'const response=await fetch("/api/collect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slug:slug,latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy})});' +
        'const result=await response.json();' +
        'if(!response.ok||!result.ok)throw new Error(result.error||"送信できませんでした。");' +
        'state.textContent="取得しました。移動します。";' +
        'window.setTimeout(function(){window.location.replace("/go/"+encodeURIComponent(slug));},' + String(delay*1000) + ');' +
      '}catch(error){state.textContent="位置情報を保存できませんでした。転送は行っていません。";}' +
    '},function(error){' +
      'if(error&&error.code===1)state.textContent="位置情報が許可されませんでした。位置情報は送信されていません。";' +
      'else if(error&&error.code===3)state.textContent="位置情報の取得がタイムアウトしました。位置情報は送信されていません。";' +
      'else state.textContent="位置情報を取得できませんでした。位置情報は送信されていません。";' +
    '},{enableHighAccuracy:true,timeout:20000,maximumAge:0});' +
    '})();</script></body></html>';
  return new Response(html, {
    status:200,
    headers:{
      "Content-Type":"text/html; charset=utf-8",
      "Cache-Control":"no-store, private, max-age=0",
      "Referrer-Policy":"no-referrer",
      "Permissions-Policy":"geolocation=(self)",
      "X-Content-Type-Options":"nosniff",
      "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    }
  });
}

function decodePathPart(value) {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9_\-\u3040-\u30FF\u3400-\u9FFF]{1,50}$/.test(decoded) ? decoded : "";
  } catch (error) {
    return "";
  }
}

function isSafeHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch (error) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[character]);
}

function jsonResponse(data, status, origin, workerOrigin) {
  const headers = new Headers({
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"
  });
  if (origin && (origin === FRONTEND_ORIGIN || origin === workerOrigin)) {
    headers.set("Access-Control-Allow-Origin",origin);
    headers.set("Vary","Origin");
    headers.set("Access-Control-Allow-Methods","POST, OPTIONS, GET");
    headers.set("Access-Control-Allow-Headers","Content-Type");
  }
  return new Response(JSON.stringify(data),{status:status,headers:headers});
}

function preflightResponse(origin, workerOrigin) {
  if (origin !== FRONTEND_ORIGIN && origin !== workerOrigin) {
    return new Response(null,{status:403});
  }
  return new Response(null,{status:204,headers:{
    "Access-Control-Allow-Origin":origin,
    "Access-Control-Allow-Methods":"POST, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Max-Age":"600",
    "Vary":"Origin"
  }});
}

function textResponse(message,status) {
  return new Response(String(message),{
    status:status,
    headers:{
      "Content-Type":"text/plain; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer"
    }
  });
}
