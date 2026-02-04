# Copilot Browser Bridge for VS Code

🔗 Chrome拡張機能と連携して、ブラウザのページ内容をGitHub Copilot / ローカルLLMで解析・対話するVS Code拡張機能

## ✨ 特徴

- **LLMルーティング**: GitHub Copilot または LM Studio（ローカルLLM）を選択可能
- **ストリーミング応答**: リアルタイムでLLMの応答を表示
- **自動起動**: VS Code起動時に自動でサーバーを開始
- **Vision対応**: スクリーンショットをLLMに送信して視覚的理解

## 🚀 インストール

### VS Code Marketplace（準備中）

Coming soon...

### 開発版（ローカルインストール）

```bash
# リポジトリをクローン
git clone https://github.com/aktsmm/copilot-browser-bridge-vscode.git
cd copilot-browser-bridge-vscode

# 依存関係をインストール
npm install

# ビルド
npm run compile

# VSIXパッケージを作成
npx @vscode/vsce package

# インストール
code --install-extension copilot-browser-bridge-vscode-0.1.0.vsix
```

## 📋 必要条件

- **VS Code** 1.90.0 以上
- **Chrome拡張機能**: [Copilot Browser Bridge](https://github.com/aktsmm/copilot-browser-bridge)
- **GitHub Copilot** サブスクリプション、または **LM Studio**（ローカルLLM）

## 🎮 使い方

1. VS Codeを起動（自動でサーバーが開始）
2. Chrome拡張機能のサイドパネルを開く
3. 任意のWebページで質問や操作指示を入力

### コマンド

- `Copilot Browser Bridge: Start Server` - サーバーを手動で開始
- `Copilot Browser Bridge: Stop Server` - サーバーを停止

## ⚙️ 設定

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| `copilotBrowserBridge.serverPort` | 3210 | ローカルサーバーのポート番号 |
| `copilotBrowserBridge.autoStart` | true | VS Code起動時に自動でサーバーを開始 |

## 🔧 開発

```bash
# ビルド
npm run compile

# ウォッチモード
npm run watch

# VSIXパッケージ作成
npx @vscode/vsce package
```

## 📄 ライセンス

MIT License

## 🔗 関連プロジェクト

- [Copilot Browser Bridge (Chrome Extension)](https://github.com/aktsmm/copilot-browser-bridge)
