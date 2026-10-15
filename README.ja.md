# Claude CUA MCP bridge

[English](README.md) | 日本語

インストール済みのCodexデスクトップアプリのCUAランタイムを、専用のCodex app-serverを介してClaude Codeから使うための実験的なブリッジです。
ClaudeのセッションやサブエージェントごとにREPLの実行状態を分けます。
ホストが作成した実際のスレッドIDを使い、Codexモデルのターンは開始しません。
OpenAIの公式Claudeプラグインではありません。

## 必要な環境

- macOS、CUAに対応するCodexデスクトップアプリ（`ChatGPT.app` の配布名を含む）、Python 3、アプリ同梱のNode。
- PreToolUseの `updatedInput` とMCPライフサイクルフックに対応したClaude Code。
- 使用するCUAランタイムで動作確認済みのMCP起動設定。

現在のインストーラーはmacOS専用です。
ブラウザやネイティブ操作のバックエンドサービスの用意、OSの権限付与は、このブリッジでは行いません。

このリポジトリには、独自に作成したコードとテストをMITライセンスで収録しています。
ランタイム、ベンダーのツール説明、認証情報、個人設定、診断ログは収録していません。
ツールのスキーマは準備時にローカルで取得します。
[CUA context profile](https://github.com/ksmkzs/cua-context-profile/blob/main/README.ja.md)による説明の短縮は任意です。

## 準備と有効化

動作確認済みのCUA MCP設定から、`command`、`args`、`env` を持つJSONオブジェクトを用意します。
ランタイムとバックエンドに必要な環境設定を保持してください。
このJSONには端末固有の情報が含まれる場合があるため、リポジトリの外へ保存し、コミットしないでください。

このリポジトリのディレクトリで実行します。

```sh
python3 install.py --prepare --app /Applications/Codex.app --cua-config /path/to/local-cua.json
python3 install.py --activate --app /Applications/Codex.app
```

アプリの配布名に応じて `/Applications/ChatGPT.app` などを指定します。
`--app` を省略すると、一般的なApplicationsディレクトリから候補を探します。
`--cua-config` を省略した場合は、既存のClaude設定にある `codex-computer-use` エントリーを読みます。

準備処理は `~/.codex/cua-claude-mcp` にコードを配置し、ルーティング情報の整合性を検証するローカル鍵を生成して、ランタイムのツール一覧を取得します。
準備時には `CUA_REPL_ENABLED_SURFACES` を `browser,computer` に設定するため、両方の機能に対応する起動設定が必要です。
この段階ではUI操作、フックの有効化、モデルターンの開始は行いません。
有効化すると、対象のMCPエントリーとフックを追加し、それ以外の設定を保持します。
その後、新しいClaudeセッションを開始してください。

配置先や設定ファイルの場所は、`--root`、`--claude-config`、`--claude-settings` で変更できます。
準備、有効化、復元には同じ引数を使ってください。
準備済みの設定がある配置先は上書きしないため、更新の確認には新しいディレクトリを指定します。
既存のインストール先や有効化記録を削除して更新を強制しないでください。

## 元の設定へ戻す

```sh
python3 install.py --restore --app /Applications/Codex.app
```

以前のMCPエントリーを復元し、以前のエントリーがなければ削除します。
フックは、このブリッジが追加したものだけを取り除きます。
導入後に設定が変わっている場合は、不明確な上書きを避けるため復元を停止します。
デスクトップアプリや動作中のClaudeセッションは強制終了しません。

## 操作とセッション管理

`js` と `js_reset` を使い、最初の呼び出しで返された説明に従って操作します。
任意のcontext profileが提供する `cua.documentation()` の存在は前提にしません。
PreToolUseフックが署名付きのルーティング情報を追加するため、`_bridge_context` を手動で作成しないでください。

Stop、StopFailure、SubagentStop、SessionEndは、対応するランタイムの実行状態へ通知します。
キャンセル時には、必要に応じて専用ホストを破棄します。
結果が不明な操作は自動再実行せず、UI状態を取り直してから次の操作を判断します。
ファイルロックで直列化する対象は、このブリッジのプロセスです。
人間や別のデスクトップ操作との排他制御は行いません。

対応する承認フォームやURLはClaudeへ転送し、未対応の要求は拒否します。
既存ホストの承認設定とサンドボックス設定は保持します。
`turn_ended` RPCへの応答があっても、ネイティブカーソルが消えたことを確認したとは扱いません。
カーソルの残留は上流側の未解決の動作です。

## ローカルに保存する記録

`events.jsonl` にはIDと結果のフラグを記録します。
コード、画面内容、承認要求の本文は記録しませんが、セッションを識別できる情報は含まれます。
ログの自動ローテーションは実装していません。
削除する場合は、すべてのブリッジセッションが終了してから行ってください。
インストール先の状態ファイルをコミットしないでください。

## テストと互換性確認

Node.js 22以上、npm、Python 3を使います。

```sh
npm test
python3 -m unittest discover -s tests
```

テスト用のホストとツールを使い、ルーティング、エージェント間の分離、承認の転送、スキーマ変更、キャンセル、ロック、終了通知を検証します。
GUI操作全体の互換性は検証しません。
新しい環境では、読み取り専用のCUA観測で動作を確認してから操作に使ってください。
ブラウザへの対応範囲は、設定したホストによって変わります。

ランタイムが要求するツールスキーマを、準備時に保存したスナップショットと比較します。
変更を検出すると実行を停止します。
新しいスナップショットを取得しただけでは意味的な互換性を確認できないため、変更点の確認と実機検証が必要です。

## 更新検知のDraft PR

GitHub Actionsが公開版デスクトップアプリのappcastを6時間ごとに確認します。
新版を検出すると、オフラインテストの成功後に `upstream/observed.json` を更新するDraft PRを作成または更新します。
新版がなければコミットやPRを増やしません。
管理者のMacが起動しているかどうかに依存しませんが、公開フィードとアカウント固有の配信やベータ版は異なる場合があります。

このPRは、互換性をレビューするための更新通知です。
互換性の修正、ランタイムのスキーマ更新、検証の受け入れ条件の変更、有効化、ネイティブ操作の実機検証は自動化していません。

リポジトリのActions設定で、GitHub ActionsによるPR作成を許可してください。
認証にはリポジトリの `GITHUB_TOKEN` を使い、APIキーは必要ありません。
スケジュール実行には遅延や無活動時の停止があります。
PRのテストは読み取り専用の権限で実行し、特権を持つ `pull_request_target` ワークフローは使いません。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Claudeのフック](https://code.claude.com/docs/en/hooks)、[公開appcast](https://persistent.oaistatic.com/codex-app-prod/appcast.xml)。
