# Copilot Browser Bridge for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/yamapan.copilot-browser-bridge-vscode?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-browser-bridge-vscode)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)
[![GitHub](https://img.shields.io/github/stars/aktsmm/copilot-browser-bridge-vscode?style=social)](https://github.com/aktsmm/copilot-browser-bridge-vscode)

🔗 VS Code extension that bridges browser pages with LLM (GitHub Copilot / Local LLM) for analysis and interaction

[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yamapan.copilot-browser-bridge-vscode)

[Japanese / 日本語版はこちら](README_ja.md)

## ✨ Features

- **LLM Routing**: Choose between GitHub Copilot or LM Studio (Local LLM)
- **Streaming Response**: Real-time LLM response display
- **Auto Start**: Automatically starts server on VS Code launch
- **Vision Support**: Send screenshots to LLM for visual understanding

## 📥 Installation

### VS Code Marketplace

```bash
ext install yamapan.copilot-browser-bridge-vscode
```

Or search for "Copilot Browser Bridge" in VS Code Extensions (`Ctrl+Shift+X`)

### Manual Installation

1. Download `.vsix` from [Releases](https://github.com/aktsmm/copilot-browser-bridge-vscode/releases)
2. VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` file

## 📋 Requirements

- **VS Code** 1.90.0 or higher
- **Chrome Extension**: [Copilot Browser Bridge](https://github.com/aktsmm/copilot-browser-bridge)
- **GitHub Copilot** subscription, or **LM Studio** (Local LLM)

## 🎮 Usage

1. Launch VS Code (server starts automatically)
2. Open Chrome extension side panel
3. Enter questions or operation instructions on any web page

### Commands

- `Copilot Browser Bridge: Start Server` - Manually start the server
- `Copilot Browser Bridge: Stop Server` - Stop the server

## ⚙️ Settings

| Setting                           | Default | Description                         |
| --------------------------------- | ------- | ----------------------------------- |
| `copilotBrowserBridge.serverPort` | 3210    | Local server port number            |
| `copilotBrowserBridge.autoStart`  | true    | Auto-start server on VS Code launch |

## 🔧 Development

```bash
# Build
npm run compile

# Watch mode
npm run watch

# Create VSIX package
npx @vscode/vsce package
```

## 📄 License

MIT License © [yamapan](https://github.com/aktsmm)

## 🔒 Privacy

- **Data Collection**: None
- **Communication**: Only operates on localhost (localhost:3210)
- **External Transmission**: Only sent to Copilot/Local LLM based on provider selection

## 🔗 Related Projects

- [Copilot Browser Bridge (Chrome Extension)](https://github.com/aktsmm/copilot-browser-bridge)

## 👤 Author

yamapan (https://github.com/aktsmm)
