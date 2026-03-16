import * as vscode from "vscode";
import {
  isSafeRelativePath,
  toWorkspaceFileUri as toWorkspaceFileUriShared,
} from "./path-safety";

export interface LLMSettings {
  provider: "copilot" | "copilot-agent" | "lm-studio";
  copilot: {
    model: string;
  };
  lmStudio: {
    endpoint: string;
    model: string;
  };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  settings: LLMSettings;
  messages: ChatMessage[];
  pageContent: string;
  screenshot?: string; // Base64 encoded image for Vision API
  operationMode?: "text" | "hybrid" | "screenshot";
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

const COPILOT_MODEL_FETCH_RETRY_COUNT = 3;
const COPILOT_MODEL_FETCH_RETRY_DELAY_MS = 150;

// Tool definitions for agent mode
interface ToolCall {
  name: string;
  parameters: Record<string, unknown>;
}

interface ToolResult {
  success: boolean;
  result: string;
}

export class LLMRouter {
  private async selectCopilotModels(
    selector: { family?: string } = {},
  ): Promise<vscode.LanguageModelChat[]> {
    let models: vscode.LanguageModelChat[] = [];

    for (
      let attempt = 0;
      attempt < COPILOT_MODEL_FETCH_RETRY_COUNT;
      attempt++
    ) {
      models = await vscode.lm.selectChatModels({
        vendor: "copilot",
        ...selector,
      });

      if (models.length > 0) {
        return models;
      }

      if (attempt < COPILOT_MODEL_FETCH_RETRY_COUNT - 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, COPILOT_MODEL_FETCH_RETRY_DELAY_MS);
        });
      }
    }

    return models;
  }

  private bindAbortSignal(
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): () => void {
    if (!signal) {
      return () => {};
    }

    if (signal.aborted) {
      onAbort();
      return () => {};
    }

    const handler = () => {
      onAbort();
    };
    signal.addEventListener("abort", handler, { once: true });

    return () => {
      signal.removeEventListener("abort", handler);
    };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];

    // Copilot models
    try {
      const copilotModels = await this.selectCopilotModels();
      const seenFamilies = new Set<string>();

      for (const model of copilotModels) {
        if (seenFamilies.has(model.family)) {
          continue;
        }

        seenFamilies.add(model.family);
        models.push({
          provider: "copilot",
          id: model.family,
          name: `${model.name} (${model.family})`,
        });
      }
    } catch (error) {
      console.log("Copilot models not available:", error);
    }

    // LM Studio models would be fetched from endpoint
    models.push({
      provider: "lm-studio",
      id: "local",
      name: "LM Studio (Local)",
    });

    return models;
  }

  async chat(
    request: ChatRequest,
    abortSignal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    const { settings, messages, pageContent, screenshot } = request;

    // Build system prompt with page content
    const systemPrompt = this.buildSystemPrompt(pageContent);

    if (settings.provider === "copilot") {
      return this.chatWithCopilot(
        settings.copilot.model,
        systemPrompt,
        messages,
        screenshot,
        abortSignal,
      );
    } else if (settings.provider === "copilot-agent") {
      return this.chatWithCopilotAgent(
        settings.copilot.model, // Pass selected model
        pageContent,
        messages,
        screenshot,
        abortSignal,
      );
    } else {
      return this.chatWithLMStudio(
        settings.lmStudio,
        systemPrompt,
        messages,
        abortSignal,
      );
    }
  }

  private buildSystemPrompt(pageContent: string): string {
    const browserActionsDoc = `
You can control the browser by including action commands in your response.
Use this format: [ACTION: type, parameters]

Available browser actions:
- [ACTION: navigate, https://example.com] - Go to URL
- [ACTION: click, #button-id] or [ACTION: click, ref:e5] - Click element
- [ACTION: doubleclick, ref:e5] - Double click element
- [ACTION: click, {"selector":"ref:e5","button":"right","modifiers":["Control"]}] - Click with options
- [ACTION: type, #input-id, text to type] - Type text into input
- [ACTION: type, #input-id, text, submit] - Type and press Enter
- [ACTION: type, #input-id, text, slowly] - Type slowly (per character)
- [ACTION: scroll, down] or [ACTION: scroll, up] - Scroll the page
- [ACTION: back] - Go back in history
- [ACTION: forward] - Go forward in history
- [ACTION: reload] - Reload the page
- [ACTION: newtab, https://example.com] - Open new tab
- [ACTION: closetab] - Close current tab
- [ACTION: screenshot] - Take screenshot
- [ACTION: waitForSelector, #selector, 5000] - Wait for selector
- [ACTION: waitForText, some text, 5000] - Wait for text to appear
- [ACTION: waitForTextGone, some text, 5000] - Wait for text to disappear

Enhanced form actions:
- [ACTION: radio, ref:e5] - Select a radio button by ref
- [ACTION: radio, [role="group"], 分からない] - Select radio by label text in group
- [ACTION: check, ref:e5] - Check a checkbox
- [ACTION: uncheck, ref:e5] - Uncheck a checkbox
- [ACTION: select, ref:e5, Option Text] - Select dropdown option
- [ACTION: slider, ref:e5, 50] - Set slider to value (0-100)
- [ACTION: hover, ref:e5] - Hover over element
- [ACTION: focus, ref:e5] - Focus on element
- [ACTION: fillForm, field1=value1; field2=value2] - Fill multiple fields
- [ACTION: upload, ref:e5] - Open file picker (manual selection)

Tips for forms:
- For radio buttons: Use [ACTION: radio, ref:eX] where eX is the radio ref
- For multiple choice questions: Click the radio option directly
- Look for elements with role="radio" or type="radio"

Advanced actions:
- [ACTION: clickXY, 200, 300] - Click at screen coordinates
- [ACTION: pressKey, Enter] - Press a key
- [ACTION: evaluate, () => document.title] - Evaluate JavaScript
- [ACTION: getConsole] - Get console logs
- [ACTION: getNetwork, static] - Get network requests (include static)
- [ACTION: handleDialog, accept, optional text] - Handle dialogs

Available file actions (creates files in VS Code workspace):
- [FILE: create, path/to/file.md, content here] - Create a new file
- [FILE: append, path/to/file.md, content to append] - Append to existing file

When the user asks you to perform browser actions or create files/reports, include the appropriate [ACTION: ...] or [FILE: ...] commands in your response.
`;

    if (!pageContent || pageContent.trim().length === 0) {
      return `あなたはユーザーの頼れるアシスタントです。ブラウザを操作し、ファイルを作成できます。

## できること
${browserActionsDoc}

## 心がけ
- ユーザーの意図を理解し、適切なアクションを提案
- 分からないことは確認してから実行
- 結果を分かりやすく報告

ユーザーと同じ言語で応答してください。`;
    }

    return `あなたはユーザーの頼れるアシスタントです。Webページを分析し、ブラウザを操作し、ファイルを作成できます。

---ページ内容---
${pageContent.slice(0, 20000)}
---ページ内容ここまで---

## できること
${browserActionsDoc}

## 心がけ
- ページ内容を正確に把握して質問に答える
- 必要に応じてブラウザ操作やファイル作成を提案
- 簡潔で分かりやすい回答

ユーザーと同じ言語で応答してください。`;
  }

  private buildAgentSystemPrompt(
    pageContent: string,
    screenshotMode: boolean,
  ): string {
    const currentStateAnalysis = screenshotMode
      ? "2. **現状分析**: スクリーンショットとDOM要素から、今どの段階にいるか？"
      : "2. **現状分析**: ページスナップショットから、今どの段階にいるか？";

    const elementIdentification = screenshotMode
      ? `## 📍 要素の特定方法（優先順位）
1. **[eXX] ref番号** ← 最も確実。必ずこれを使う
2. **テキストマッチ** ← ref番号がない場合のみ

例:
[e5] button "次へ" → [ACTION: click, e5]
[e12] radio "そう思わない" → [ACTION: click, e12]`
      : `## 📍 要素の特定方法
ページスナップショットの各要素には [eXX] という参照番号があります。
これを使って確実にクリックします。

例:
[e5] button "次へ" → [ACTION: click, e5]
[e12] input "検索" → [ACTION: type, e12, 検索ワード]`;

    const fileOperationSection = screenshotMode
      ? ""
      : `
## 📁 ファイル操作の活用
調査結果やデータを保存するときに使用:

[FILE: create, output/report.md, # 調査レポート
## 概要
ここに要約...

## 詳細
ここに詳細...
]`;

    const successDefinitionSection = screenshotMode
      ? ""
      : `
## 🏆 成功の定義
タスクが完了したら、以下を報告:
1. 何を達成したか
2. 重要な発見や注意点
3. 次のアクション（あれば）`;

    const pageSection = pageContent
      ? screenshotMode
        ? `\n## 📄 現在のページ情報:\n${pageContent.slice(0, 10000)}`
        : `\n## 📄 現在のWebページ:\n${pageContent.slice(0, 12000)}`
      : "";

    return `あなたは「ユーザーの右腕」として働く、超有能なブラウザ操作AIエージェントです。
ユーザーが達成したいゴールを深く理解し、自律的に考え、確実に実行します。

## 🎯 あなたの使命
- ユーザーの意図を先読みし、期待以上の結果を出す
- 困難な状況でも諦めず、創造的な解決策を見つける
- 進捗を分かりやすく報告し、ユーザーを安心させる

## 🔍 調査タスクの実行方法（超重要！）
「調べて」「探して」「検索して」と言われたら、以下を**必ず最後まで**実行:

1. **検索実行**: Google等で検索 [ACTION: navigate, https://www.google.com/search?q=検索ワード]
2. **結果を読む**: 検索結果ページの内容を確認
3. **詳細を調査**: 有用そうなリンクをクリックして詳細を読む
4. **情報を収集**: 複数のソースから情報を集める
5. **回答をまとめる**: 収集した情報を整理して**最終的な回答**を提供

❌ ダメな例: 「〜で検索できます」「〜を調べてみてください」で終わる
✅ 良い例: 実際に検索し、結果を読み、「調査の結果、〜ということが分かりました」と回答

## 🧠 思考プロセス（必ず実行）
1. **ゴール理解**: ユーザーは最終的に何を達成したいのか？
${currentStateAnalysis}
3. **計画立案**: ゴールまでの最短・最確実なステップは？
4. **リスク予測**: 何が失敗しそうか？代替案は？
5. **実行**: 1ステップずつ確実に実行

${elementIdentification}

## 🔧 アクション形式
\`\`\`
[ACTION: click, eXX]           # 要素をクリック
[ACTION: type, eXX, テキスト]   # テキスト入力
[ACTION: scroll, down/up]      # スクロール
[ACTION: navigate, URL]        # URL移動
[ACTION: screenshot]           # 最新状態を確認
[ACTION: radio, eXX]           # ラジオボタン選択（重要！）
[ACTION: select, eXX, 値]       # ドロップダウン選択
[ACTION: slider, eXX, 50]      # スライダー値設定（0-100）
[ACTION: hover, eXX]           # ホバー
[FILE: create, パス, 内容]      # ファイル作成
[FILE: append, パス, 内容]      # ファイル追記
\`\`\`

## 📝 フォーム操作のコツ
- **ラジオボタン**: role="radio" の要素を [ACTION: radio, eXX] でクリック
- **チェックボックス**: [ACTION: click, eXX] でトグル
- **ドロップダウン**: [ACTION: select, eXX, 選択肢テキスト]
- **スライダー**: [ACTION: slider, eXX, 値]
${fileOperationSection}

## 💡 プロとしての行動指針
- **最後までやり遂げる**: 途中で投げ出さない。結果を出すまで続ける
- **先回り**: 「次は何が必要か」を常に考える
- **報告**: 「今これをしています」「次はこれをします」と明確に伝える
- **確認**: 重要な操作の前は「〜してよろしいですか？」と確認
- **エラー対応**: 失敗したら原因を分析し、別のアプローチを試す
- **完了報告**: 何を達成したか、結果はどうだったかを簡潔に報告

## 🚨 トラブル時の対応
- 要素が見つからない → スクロールして探す、または別のセレクタを試す
- ページが読み込み中 → 少し待ってからスクリーンショットで確認
- 予期せぬポップアップ → 閉じるか、内容を確認して対処
- 操作がブロックされた → ユーザーに状況を報告し、代替案を提案
${successDefinitionSection}
${pageSection}`;
  }

  private async *chatWithCopilot(
    modelFamily: string,
    systemPrompt: string,
    messages: ChatMessage[],
    screenshot?: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<string> {
    try {
      // Try to find model by family first
      let models = await this.selectCopilotModels({ family: modelFamily });

      // If not found, try by id
      if (models.length === 0) {
        models = await this.selectCopilotModels();
        // Filter by id containing the model name
        const filtered = models.filter(
          (m) =>
            m.id.toLowerCase().includes(modelFamily.toLowerCase()) ||
            m.family.toLowerCase().includes(modelFamily.toLowerCase()),
        );
        if (filtered.length > 0) {
          models = filtered;
        }
      }

      const model = models[0];

      if (!model) {
        yield `エラー: モデル "${modelFamily}" が見つかりません。\n\n利用可能なモデル:\n`;
        const allModels = await this.selectCopilotModels();
        for (const m of allModels) {
          yield `- ${m.family} (${m.id})\n`;
        }
        return;
      }

      console.log(`Using model: ${model.id} (family: ${model.family})`);
      yield `[Using: ${model.family}]\n\n`;

      // Build messages for Copilot
      const chatMessages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        ...messages.map((msg) =>
          msg.role === "user"
            ? vscode.LanguageModelChatMessage.User(msg.content)
            : vscode.LanguageModelChatMessage.Assistant(msg.content),
        ),
      ];

      const tokenSource = new vscode.CancellationTokenSource();
      const unbindAbort = this.bindAbortSignal(abortSignal, () => {
        tokenSource.cancel();
      });
      try {
        const response = await model.sendRequest(
          chatMessages,
          {},
          tokenSource.token,
        );

        for await (const chunk of response.text) {
          yield chunk;
        }
      } finally {
        unbindAbort();
        tokenSource.dispose();
      }
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        const lmError = error as vscode.LanguageModelError;
        if (lmError.code === "NoPermissions") {
          yield `エラー: Copilotへのアクセス権限がありません。\n\nVS Codeで以下を実行してください:\n1. Ctrl+Shift+P → "GitHub Copilot: Manage Language Models"\n2. この拡張機能へのアクセスを許可`;
        } else {
          yield `エラー: ${lmError.message} (${lmError.code})`;
        }
      } else {
        throw error;
      }
    }
  }

  private async *chatWithCopilotAgent(
    modelFamily: string,
    pageContent: string,
    messages: ChatMessage[],
    screenshot?: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<string> {
    try {
      // Use the selected model for agent mode
      let models = await this.selectCopilotModels({ family: modelFamily });

      // If not found by family, search by id
      if (models.length === 0) {
        const allModels = await this.selectCopilotModels();
        const filtered = allModels.filter(
          (m) =>
            m.id.toLowerCase().includes(modelFamily.toLowerCase()) ||
            m.family.toLowerCase().includes(modelFamily.toLowerCase()),
        );
        if (filtered.length > 0) {
          models = filtered;
        } else {
          models = allModels; // Fallback to any available model
        }
      }

      const model = models[0];

      if (!model) {
        yield "エラー: エージェントモード用のモデルが見つかりません";
        return;
      }

      yield `[Agent Mode: ${model.family}]\n\n`;

      // Build agent system prompt based on whether screenshot is available
      const screenshotMode = !!screenshot;
      const agentSystemPrompt = this.buildAgentSystemPrompt(
        pageContent,
        screenshotMode,
      );

      // Build chat messages, including screenshot if available
      const chatMessages: vscode.LanguageModelChatMessage[] = [];

      if (screenshot) {
        // Add system prompt with screenshot
        // Handle both data URL format and raw base64
        const normalizedScreenshot = screenshot.trim();
        let base64Data = normalizedScreenshot;
        let mimeType = "image/png";

        // Robust data URL handling (supports extra params like charset)
        if (normalizedScreenshot.startsWith("data:")) {
          const commaIndex = normalizedScreenshot.indexOf(",");
          if (commaIndex !== -1) {
            const header = normalizedScreenshot.slice(5, commaIndex);
            const headerParts = header.split(";");
            const headerMime = headerParts[0]?.toLowerCase();
            if (headerMime) {
              mimeType = headerMime;
              if (mimeType === "image/jpg") {
                mimeType = "image/jpeg";
              }
            }
            base64Data = normalizedScreenshot.slice(commaIndex + 1);
            console.log(
              `[Screenshot] Detected data URL with mimeType: ${mimeType}`,
            );
          }
        } else {
          console.log(`[Screenshot] Raw base64 data, assuming ${mimeType}`);
        }

        // Remove whitespace/newlines from base64 data if any
        base64Data = base64Data.replace(/[\r\n\s]+/g, "");

        const imageBuffer = Buffer.from(base64Data, "base64");
        const imageData = new Uint8Array(imageBuffer);

        console.log(`[Screenshot] Image data size: ${imageData.length} bytes`);
        console.log(
          `[Screenshot] First 4 bytes (magic): ${Array.from(
            imageData.slice(0, 4),
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}`,
        );

        // Check magic bytes to detect actual format
        // JPEG: FF D8 FF
        // PNG: 89 50 4E 47
        const isJpeg =
          imageData[0] === 0xff &&
          imageData[1] === 0xd8 &&
          imageData[2] === 0xff;
        const isPng =
          imageData[0] === 0x89 &&
          imageData[1] === 0x50 &&
          imageData[2] === 0x4e &&
          imageData[3] === 0x47;
        const isWebp =
          imageData[0] === 0x52 &&
          imageData[1] === 0x49 &&
          imageData[2] === 0x46 &&
          imageData[3] === 0x46 &&
          imageData[8] === 0x57 &&
          imageData[9] === 0x45 &&
          imageData[10] === 0x42 &&
          imageData[11] === 0x50;

        const detectedMime = isPng
          ? "image/png"
          : isJpeg
            ? "image/jpeg"
            : isWebp
              ? "image/webp"
              : null;

        if (detectedMime && mimeType !== detectedMime) {
          console.log(
            `[Screenshot] WARNING: Data is ${detectedMime} but mimeType is ${mimeType}, correcting...`,
          );
          mimeType = detectedMime;
        }

        console.log(`[Screenshot] Final mimeType: ${mimeType}`);
        console.log(
          `[Screenshot] Detected format: ${isJpeg ? "jpeg" : isPng ? "png" : isWebp ? "webp" : "unknown"}`,
        );

        // Validate that we have actual image data
        if (imageData.length < 100) {
          console.error("Screenshot data too small, skipping image");
          chatMessages.push(
            vscode.LanguageModelChatMessage.User(agentSystemPrompt),
          );
        } else if (!detectedMime || (!isJpeg && !isPng && !isWebp)) {
          console.error(
            "Screenshot format unsupported or invalid, skipping image",
          );
          chatMessages.push(
            vscode.LanguageModelChatMessage.User(agentSystemPrompt),
          );
        } else {
          chatMessages.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelTextPart(agentSystemPrompt),
              new vscode.LanguageModelTextPart(
                "\n\n## スクリーンショット (現在のページ):",
              ),
              new vscode.LanguageModelDataPart(imageData, mimeType),
            ]),
          );
        }
      } else {
        chatMessages.push(
          vscode.LanguageModelChatMessage.User(agentSystemPrompt),
        );
      }

      // Add conversation history
      for (const msg of messages) {
        if (msg.role === "user") {
          chatMessages.push(vscode.LanguageModelChatMessage.User(msg.content));
        } else {
          chatMessages.push(
            vscode.LanguageModelChatMessage.Assistant(msg.content),
          );
        }
      }

      // Define tools for the agent
      const tools: vscode.LanguageModelChatTool[] = [
        {
          name: "search_workspace",
          description: "ワークスペース内でファイルやコードを検索します",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "検索クエリ" },
              filePattern: {
                type: "string",
                description: "ファイルパターン (例: *.ts)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "read_file",
          description: "ワークスペース内のファイルを読み取ります",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "ファイルパス" },
            },
            required: ["path"],
          },
        },
        {
          name: "create_file",
          description: "ワークスペースに新しいファイルを作成します",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "ファイルパス" },
              content: { type: "string", description: "ファイルの内容" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "run_terminal",
          description: "ターミナルでコマンドを実行します",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "実行するコマンド" },
            },
            required: ["command"],
          },
        },
        {
          name: "browser_action",
          description:
            "ブラウザを操作します。CSSセレクタを正確に指定してください。",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "navigate",
                  "click",
                  "type",
                  "scroll",
                  "back",
                  "forward",
                  "reload",
                ],
                description: "アクション種類",
              },
              selector: {
                type: "string",
                description:
                  "CSSセレクタ (例: #submit-btn, .btn-primary, input[type='radio']:first-of-type, button[data-test='agree'])",
              },
              value: {
                type: "string",
                description: "navigate時のURL、またはtype時の入力テキスト",
              },
            },
            required: ["action"],
          },
        },
      ];

      const tokenSource = new vscode.CancellationTokenSource();
      const unbindAbort = this.bindAbortSignal(abortSignal, () => {
        tokenSource.cancel();
      });
      try {
        let continueLoop = true;
        let iterationCount = 0;
        const maxIterations = 5;

        while (continueLoop && iterationCount < maxIterations) {
          iterationCount++;

          const response = await model.sendRequest(
            chatMessages,
            { tools },
            tokenSource.token,
          );

          const toolCalls: Array<{
            callId: string;
            name: string;
            parameters: unknown;
          }> = [];

          for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              yield part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              toolCalls.push({
                callId: part.callId,
                name: part.name,
                parameters: part.input,
              });
            }
          }

          if (toolCalls.length === 0) {
            continueLoop = false;
          } else {
            // Execute tools and add results
            const assistantParts: vscode.LanguageModelToolCallPart[] = [];
            const userResultParts: vscode.LanguageModelToolResultPart[] = [];

            for (const toolCall of toolCalls) {
              yield `\n\n🔧 ツール実行: ${toolCall.name}\n`;
              const result = await this.executeAgentTool(
                toolCall.name,
                toolCall.parameters as Record<string, unknown>,
              );
              yield `📋 結果: ${result.result}\n`;

              assistantParts.push(
                new vscode.LanguageModelToolCallPart(
                  toolCall.callId,
                  toolCall.name,
                  toolCall.parameters as object,
                ),
              );
              userResultParts.push(
                new vscode.LanguageModelToolResultPart(toolCall.callId, [
                  new vscode.LanguageModelTextPart(result.result),
                ]),
              );
            }

            // Add tool calls + results in proper API format
            chatMessages.push(
              vscode.LanguageModelChatMessage.Assistant(assistantParts),
              vscode.LanguageModelChatMessage.User(userResultParts),
            );
          }
        }
      } finally {
        unbindAbort();
        tokenSource.dispose();
      }
    } catch (error) {
      console.error("Agent mode error:", error);
      yield `\n\n⚠️ エージェントモードエラー: ${error instanceof Error ? error.message : String(error)}`;

      // Fallback to regular chat
      yield `\n\n代わりにChatモードで応答します...\n\n`;
      for await (const chunk of this.chatWithCopilot(
        "gpt-4o",
        this.buildSystemPrompt(pageContent),
        messages,
        undefined,
        abortSignal,
      )) {
        yield chunk;
      }
    }
  }

  private async executeAgentTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case "search_workspace": {
          const query = String(params.query ?? "")
            .trim()
            .toLowerCase();
          const filePattern =
            typeof params.filePattern === "string" &&
            params.filePattern.trim().length > 0
              ? params.filePattern
              : "**/*";
          const files = await vscode.workspace.findFiles(
            filePattern,
            "**/node_modules/**",
            200,
          );

          const relativeFiles = files.map((f) =>
            vscode.workspace.asRelativePath(f),
          );
          const filteredFiles = query
            ? relativeFiles.filter((file) => file.toLowerCase().includes(query))
            : relativeFiles;

          const results = filteredFiles.slice(0, 20).join("\n");
          return {
            success: true,
            result: `見つかったファイル(${filteredFiles.length}件):\n${results || "なし"}`,
          };
        }

        case "read_file": {
          const requestedPath = params.path;
          const fileUri = this.toWorkspaceFileUri(requestedPath);
          if (!fileUri) {
            return {
              success: false,
              result:
                "無効なファイルパスです（ワークスペース外は読み取れません）",
            };
          }

          const content = await vscode.workspace.fs.readFile(fileUri);
          const text = new TextDecoder().decode(content);
          return { success: true, result: text.slice(0, 3000) };
        }

        case "create_file": {
          const filePath = params.path;
          if (!isSafeRelativePath(filePath)) {
            return {
              success: false,
              result: "無効なファイルパスです（相対パスのみ使用可能）",
            };
          }
          if (typeof params.content !== "string") {
            return {
              success: false,
              result: "無効なファイル内容です（文字列のみ使用可能）",
            };
          }

          const content = params.content;
          // Encode content as base64 to avoid delimiter issues
          const b64 = Buffer.from(content, "utf-8").toString("base64");
          return {
            success: true,
            result: `__DOWNLOAD_FILE__:${filePath}:${b64}:__END_DOWNLOAD__`,
          };
        }

        case "run_terminal": {
          if (!this.isAgentTerminalToolEnabled()) {
            return {
              success: false,
              result:
                "run_terminal は無効です。設定 copilotBrowserBridge.enableAgentTerminalTool を true にしてください。",
            };
          }

          const command =
            typeof params.command === "string" ? params.command.trim() : "";
          if (!command) {
            return {
              success: false,
              result: "無効なコマンドです（空文字は実行できません）",
            };
          }
          const terminal = vscode.window.createTerminal("Agent");
          terminal.show();
          terminal.sendText(command);
          return {
            success: true,
            result: `コマンドを実行しました: ${command}`,
          };
        }

        case "browser_action": {
          const action =
            typeof params.action === "string" ? params.action.trim() : "";
          const selector =
            typeof params.selector === "string" ? params.selector : "";
          const value = typeof params.value === "string" ? params.value : "";

          if (!action) {
            return {
              success: false,
              result: "無効なbrowser_actionです（actionが必要です）",
            };
          }

          // Generate proper ACTION format for Chrome extension to parse
          let actionCommand = "";
          switch (action) {
            case "navigate":
              actionCommand = `[ACTION: navigate, ${value || selector}]`;
              break;
            case "click":
              actionCommand = `[ACTION: click, ${selector}]`;
              break;
            case "type":
              actionCommand = `[ACTION: type, ${selector}, ${value}]`;
              break;
            case "scroll":
              actionCommand = `[ACTION: scroll, ${value || "down"}]`;
              break;
            case "back":
              actionCommand = `[ACTION: back]`;
              break;
            case "forward":
              actionCommand = `[ACTION: forward]`;
              break;
            case "reload":
              actionCommand = `[ACTION: reload]`;
              break;
            default:
              actionCommand = `[ACTION: ${action}, ${selector || value}]`;
          }

          return {
            success: true,
            result: actionCommand,
          };
        }

        default:
          return { success: false, result: `不明なツール: ${name}` };
      }
    } catch (error) {
      return {
        success: false,
        result: `ツール実行エラー: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private isAgentTerminalToolEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("copilotBrowserBridge")
      .get<boolean>("enableAgentTerminalTool", false);
  }

  private toWorkspaceFileUri(relativePath: unknown): vscode.Uri | null {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace || typeof relativePath !== "string") {
      return null;
    }

    return toWorkspaceFileUriShared(workspace.uri, relativePath);
  }

  private async *chatWithLMStudio(
    settings: { endpoint: string; model: string },
    systemPrompt: string,
    messages: ChatMessage[],
    abortSignal?: AbortSignal,
  ): AsyncIterable<string> {
    const endpoint = settings.endpoint || "http://localhost:1234";
    let timedOut = false;

    try {
      // Build OpenAI-compatible request
      const requestMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      ];

      console.log(`LM Studio: Connecting to ${endpoint}/v1/chat/completions`);
      const controller = new AbortController();
      const timeoutMs = 30000;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const unbindAbort = this.bindAbortSignal(abortSignal, () => {
        controller.abort();
      });

      let response: Response;
      try {
        response = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: settings.model || "local-model",
            messages: requestMessages,
            stream: true,
          }),
          signal: controller.signal,
        });
      } finally {
        unbindAbort();
        clearTimeout(timeoutHandle);
      }

      console.log(`LM Studio: Response status ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        yield `エラー: LM Studio接続失敗 (${response.status})\n${errorText}`;
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let streamDone = false;
      let parseErrorCount = 0;

      const processLine = async function* (
        line: string,
      ): AsyncIterable<string> {
        const normalizedLine = line.trimEnd();
        if (!normalizedLine.startsWith("data:")) {
          return;
        }

        const data = normalizedLine.slice(5).trimStart();
        if (data === "[DONE]") {
          streamDone = true;
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          parseErrorCount++;
          if (parseErrorCount <= 3) {
            console.warn(
              `LM Studio: Failed to parse streamed JSON line (${parseErrorCount})`,
              data.slice(0, 120),
            );
          }
        }
      };

      if (!reader) {
        yield "エラー: レスポンスストリームを取得できません";
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode();
        } else {
          pending += decoder.decode(value, { stream: true });
        }

        let lineBreakIndex = pending.indexOf("\n");
        while (lineBreakIndex !== -1) {
          const line = pending.slice(0, lineBreakIndex);
          pending = pending.slice(lineBreakIndex + 1);

          for await (const content of processLine(line)) {
            yield content;
          }

          if (streamDone) {
            return;
          }

          lineBreakIndex = pending.indexOf("\n");
        }

        if (done) {
          if (pending.length > 0) {
            for await (const content of processLine(pending)) {
              yield content;
            }
          }
          break;
        }
      }
    } catch (error) {
      console.error("LM Studio error:", error);
      if (error instanceof Error && error.name === "AbortError") {
        if (abortSignal?.aborted && !timedOut) {
          return;
        }
        yield "エラー: LM Studio の応答がタイムアウトしました。しばらく待ってから再試行してください。";
        return;
      }
      yield `エラー: LM Studioに接続できません。\n\n確認事項:\n1. LM Studioが起動しているか\n2. サーバーがStartedになっているか (Local Server → Start)\n3. エンドポイントが正しいか (デフォルト: http://localhost:1234)\n\n詳細: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
