# GPS Control Center（GitHub + GASだけ）

Cloudflare Workersなどの追加サービスを使わず、GitHub PagesとGoogle Apps Script、Googleスプレッドシートで動かすURL管理アプリです。

## できること

- GAS管理画面で管理者パスワード認証
- 好きな識別文字（日本語・英数字・`-`・`_`）で専用URLを発行
- 相手画面に出す文章、HTTPSリダイレクト先、有効期限、待ち時間を設定
- 相手がGitHub PagesのURLを開くと白背景・文字中心の説明画面を表示
- ブラウザ標準の位置情報許可を要求し、許可されたときだけ位置情報をGASに送信
- GAS管理画面で取得日時・緯度・経度・精度を確認
- URLの無効化

## HTTP 301についての重要事項

GitHub Pages + GASだけでは、任意のHTTP 301レスポンスを返すことはできません。Apps Scriptの`TextOutput`にはHTTPステータスコードを設定するメソッドがなく、ContentServiceはセキュリティ上の理由で`script.googleusercontent.com`へ内部リダイレクトしてコンテンツを配信します。

そのため、本アプリは位置情報保存成功後に、GitHub Pages側のJavaScriptで`location.replace(転送先URL)`を実行します。利用者の画面上の移動動作は実現しますが、HTTP 301ではありません。ブラウザや検索エンジンが「恒久移転」として扱うHTTP 301とは区別してください。

## ファイル

- `index.html`：相手が開く位置情報取得画面（GitHub Pages）
- `gas/Code.gs`：管理・URL発行・保存処理（Apps Script）
- `gas/Admin.html`：管理画面（Apps Script HtmlService）

## セットアップ

### 1. GitHub Pages

このリポジトリのSettings → Pagesで、`main`ブランチの`/(root)`を公開元にします。GitHub Pagesが有効ならこの工程は確認だけでOKです。

公開URLは通常、次の形式です。

`https://a09848281-prog.github.io/gps-control-center/`

### 2. Apps Scriptプロジェクト

1. `https://script.google.com/`で新しいプロジェクトを作成します。
2. プロジェクト内の`Code.gs`に、このリポジトリの`gas/Code.gs`を貼り付けます。
3. Apps Scriptの「＋」→「HTML」を選んで、ファイル名を`Admin`にします。
4. `gas/Admin.html`の内容を貼り付けます。
5. プロジェクトの設定 → スクリプト プロパティに`SETUP_KEY`を追加します。値は推測されにくいランダム文字列にしてください。
6. 関数一覧から`initializeProject`を選んで実行し、Googleスプレッドシート作成の権限を許可します。
7. 実行ログにエラーがないことを確認します。Googleドライブに`GPS Control Center - URL管理`という非公開スプレッドシートが作成されます。
8. デプロイ → 新しいデプロイ → ウェブアプリを選びます。
   - 次のユーザーとして実行：自分
   - アクセスできるユーザー：全員
9. デプロイして、末尾が`/exec`のURLをコピーします。

### 3. GASのURLをGitHub Pagesに設定

GitHubの`index.html`を編集し、次の行の値を、手順2でコピーしたGASの`/exec` URLに変更します。

`const GAS_URL='PASTE_YOUR_GAS_WEB_APP_EXEC_URL_HERE';`

変更を`main`ブランチに保存します。これでGitHub PagesからGASへ接続できます。GAS URLは公開ページに含まれますが、これは公開APIの接続先であり、管理者パスワードやセットアップキーではありません。

### 4. 管理画面の初期設定

1. GASの`/exec` URLをブラウザで開きます。
2. 初回設定画面でスクリプトプロパティに登録した`SETUP_KEY`と、10文字以上の管理者パスワードを入力します。
3. パスワード設定後、管理者ログインします。
4. URL識別文字・表示文章・転送先HTTPS URL・期限・待ち時間を設定して発行します。
5. 発行されたGitHub Pages URLを共有します。

## 位置情報の扱い

- 相手には、位置情報が管理者のスプレッドシートに保存され、保存後に指定先へ移動することをページ上で説明します。
- ブラウザで許可されたときだけ位置情報APIが成功し、その結果だけを送信します。
- 拒否・失敗・タイムアウトの場合は位置情報を保存せず、転送もしません。
- 座標はPOST本文で送信し、URLのクエリ文字列には含めません。
- スプレッドシートは公開共有しないでください。管理者自身のGoogleアカウントで保護してください。

## 注意

- 位置情報は非常に機微な情報です。取得目的と保存先を相手に明確に説明し、許可を得た場合に限って使用してください。
- ブラウザやOS、LINE内ブラウザの設定により、位置情報の許可画面が出ない場合があります。その場合は「位置情報の取得を再試行」のリンクから再度要求できます。
- リダイレクト先はHTTPSのみです。
- 識別文字は重複不可です。発行済みURLの無効化は管理画面から行えます。
- 301ではなく、JavaScriptによる画面遷移です。