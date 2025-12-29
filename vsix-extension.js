"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const provider_1 = require("./provider");
const storage_1 = require("./storage");
function activate(context) {
    const storage = new storage_1.Storage(context.globalState);
    // Management command to configure API key
    context.subscriptions.push(vscode.commands.registerCommand("openai.custom.manage", async () => {
        await storage.showAndSetConfig();
    }));
    // Build a descriptive User-Agent to help quantify API usage and
    // register the language model provider. This is intentionally
    // wrapped in a try/catch so that failures here never prevent the
    // management command from being available.
    try {
        const ext = vscode.extensions.getExtension("lwaay.openai-custom-vscode-chat") ??
            vscode.extensions.getExtension("LijCoder.openai-custom-vscode-chat");
        const extVersion = ext?.packageJSON?.version ?? "unknown";
        const vscodeVersion = vscode.version;
        // Keep UA minimal: only extension version and VS Code version
        const ua = `openai-custom-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;
        const lmApi = vscode.lm;
        if (!lmApi || typeof lmApi.registerLanguageModelChatProvider !== "function") {
            // If the LM API is not available (older VS Code), surface a clear error.
            void vscode.window.showErrorMessage("OpenAI Custom provider requires a VS Code build with the Language Model Chat Provider API (vscode.lm). " +
                "Please upgrade VS Code to a newer version to use the custom provider.");
            return;
        }
        const provider = new provider_1.OpenAICustomChatModelProvider(storage, ua);
        // Register the OpenAI Custom provider under the vendor id used in package.json
        lmApi.registerLanguageModelChatProvider("openai-custom", provider);
    }
    catch (err) {
        console.error("[OpenAI Custom] Failed to register language model provider", err);
        void vscode.window.showErrorMessage("OpenAI Custom provider failed to initialize. Check the Extension Host logs for details.");
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map