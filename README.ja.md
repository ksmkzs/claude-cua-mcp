# claude-cua-mcp

[English](README.md)

インストール済みの Codex デスクトップアプリの Computer Use（CUA）ランタイムを、Claude Code から使うためのものです。
OpenAI や Anthropic の製品ではありません。

デスクトップアプリの中のランタイムは、普通の MCP サーバー（標準入出力）です。このリポジトリは、その無改変の
サーバーを、アプリが自分用に書き出している起動設定のまま Claude Code 向けに起動します。

```
Claude Code ── MCP（標準入出力） ── launch ── ［cua-proxy（入っていれば）］ ── node_repl（ChatGPT.app / Codex.app の中）
                                                                                   └─ アプリ自身の Computer Use サービス
```

橋渡し用の常駐プロセスも、ランタイムの複製も、保存したスキーマもありません。起動のたびにデスクトップアプリ自身の
プラグイン設定から読むので、アプリが更新されてもこちらで行う作業はありません。

## 使えるもの

- Codex アプリが自分に対して有効にしているのと同じツール: `js`、`js_reset`、`turn_ended`
- **承認は Codex と同じ。** 「Computer Use に … の使用を許可しますか？」は標準の MCP の問い合わせとして届き、
  Claude Code が表示します。代わりに承認することはありません。
- **制限も同じ。** ランタイムが拒否するアプリ（ターミナル、デスクトップアプリ自身など）は拒否されたままです。
  その判断はベンダーのサービスが行っており、ここでは一切触れません。
- 既定ではデスクトップアプリの操作のみ。ブラウザー系の機能（アプリ内ブラウザー、Chrome プラグイン）は Codex アプリ
  自身のウィンドウと会話に属するものです。試す場合は `CLAUDE_CUA_SURFACES=browser,computer` でそのまま渡せます。

[cua-context-profile](https://github.com/ksmkzs/cua-context-profile) が入っていれば、起動スクリプトはその中継を
ランタイムの手前に挟みます。説明文が短くなり、ランタイムにセッションの識別子が渡り、さらに
[safari-window-mcp](https://github.com/ksmkzs/safari-window-mcp) があればセッション専用の Safari ウィンドウが使えます。
どちらも任意です。

## 前提としていること

現行のデスクトップアプリ（26.1103 で確認）のランタイムは、自分を起動したプログラムに OpenAI の署名があるときだけ
アプリを操作できます。それ以外から起動すると、アプリの一覧は取れても、アプリへの接続で失敗します
（"Sky Computer Use native pipe startup failed"）。そのため起動スクリプトは、アプリに同梱されている Node からランタイムを起動します。
これは現時点でそう動くというだけで、保証されたものではありません。ベンダーがここを狭めた場合は、この方法は動かなくなり、残る経路はアプリが公式に文書化している `codex app-server` になります。

## インストール

macOS、Computer Use を有効にして一度は開いた Codex デスクトップアプリ、Claude Code が必要です。

```sh
sh install.sh                     # MCP サーバー "codex-computer-use"、ターン終了のフック、拒否ルール1つを追加
sh install.sh install --replace   # 同じ名前の既存サーバーを置き換える
sh install.sh uninstall
```

サーバーの登録には `claude mcp add` を使い、`~/.claude/settings.json` には次の2点だけを書き込みます
（先に `~/.local/share/claude-cua/backup/` へバックアップします）。

- `Stop`／`StopFailure` のフック。`turn_ended` を呼び、Codex のときと同じように、ターンの終わりで
  ランタイムに画面上のカーソルを片づけさせます。
- `js_add_node_module_dir` の拒否ルール。Codex アプリがモデルに見せていないツールです。

実行後、新しい Claude Code セッションを始めてください。

## デスクトップアプリが更新されたら

- **Codex アプリが起動していなくても使えます。** 起動スクリプトが新しいランタイムを起こし、ランタイムが Computer Use のサービスを自分で起動します（26.1111 で確認）。
- **更新前から動いていたセッションは、つなぎ直しが必要です。** アプリの更新より前に起動したランタイムは、新しい版のサービスに届かなくなり、アプリの操作が "Sky Computer Use native pipe startup failed" で失敗します（26.1105 → 26.1111 の更新で確認）。Claude Code で `/mcp` からこのサーバーをつなぎ直すか、新しいセッションを始めてください。cua-context-profile が入っていれば、このエラーにその旨の案内が付きます。
- **更新後の確認。** `sh check.sh` が、この Mac のアプリに対して次を確かめます：新しいランタイムが起動して応答する／見えるツールがアプリ自身の有効にしているものと同じ／アプリの一覧がエラーなく取れる／（cua-context-profile があれば）フィルターが読み込まれ、短くした説明文が返り、入口の API が残っている。`sh check.sh --record` は結果を `upstream/verified.json` に残します。
- GitHub Actions（`upstream.yml`）は公開されている新しい版を6時間ごとに記録し、確認用の下書き PR を作ります。CI は macOS のアプリを動かせないので、互換の確認は上の `check.sh` をこの Mac で実行して行います。

## 補足

- Claude Code の1セッションがランタイムの1セッションです。サブエージェントはそれを共有します。
- OS の権限は、Claude Code を動かしているアプリ（ターミナルなど）のものが使われます。
- `CLAUDE_CUA_RUNTIME=/path/to/node_repl` でランタイムを、`CODEX_APP=/path/to/App.app` でデスクトップアプリを指定できます。
- 個々の使い方が関係するソフトウェアの規約に合うかどうかは、ご自身で判断してください。ここで行うのは、
  ベンダーのサーバーを同梱のまま起動することだけで、承認や制限はそのまま残ります。

## テスト

```sh
npm test
python3 -m unittest discover -s tests      # 更新の監視
```

MIT ライセンス。
