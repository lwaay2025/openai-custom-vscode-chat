import * as vscode from "vscode";
import { OpenAICustomChatModelProvider } from "./provider";
import { Storage } from "./storage";

export function activate(context: vscode.ExtensionContext) {
  const storage = new Storage(context.globalState);

  // Management command to configure API key
  context.subscriptions.push(
    vscode.commands.registerCommand("openai.custom.manage", async () => {
      await storage.showAndSetConfig();
    })
  );

  // Build a descriptive User-Agent to help quantify API usage and
  // register the language model provider. This is intentionally
  // wrapped in a try/catch so that failures here never prevent the
  // management command from being available.
  try {
    const ext =
      vscode.extensions.getExtension("lwaay.openai-custom-vscode-chat") ??
      vscode.extensions.getExtension("LijCoder.openai-custom-vscode-chat");
    const extVersion = ext?.packageJSON?.version ?? "unknown";
    const vscodeVersion = vscode.version;
    // Keep UA minimal: only extension version and VS Code version
    const ua = `openai-custom-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

    const lmApi = (vscode as any).lm;
    if (!lmApi || typeof lmApi.registerLanguageModelChatProvider !== "function") {
      // If the LM API is not available (older VS Code), surface a clear error.
      void vscode.window.showErrorMessage(
        "OpenAI Custom provider requires a VS Code build with the Language Model Chat Provider API (vscode.lm). " +
          "Please upgrade VS Code to a newer version to use the custom provider."
      );
      return;
    }

    const provider = new OpenAICustomChatModelProvider(storage, ua);
    // Register the OpenAI Custom provider under the vendor id used in package.json
    lmApi.registerLanguageModelChatProvider("openai-custom", provider);
  } catch (err) {
    console.error("[OpenAI Custom] Failed to register language model provider", err);
    void vscode.window.showErrorMessage(
      "OpenAI Custom provider failed to initialize. Check the Extension Host logs for details."
    );
  }
}

export function deactivate() {}
