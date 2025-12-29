import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  ProvideLanguageModelChatResponseOptions,
  LanguageModelResponsePart,
  Progress,
} from "vscode";
import { ProxyAgent } from "undici";
import type { OpenAICustomModelConfig, OpenAICustomLanguageModelChatInformation } from "./types";
import { convertTools, tryParseJSONObject, validateRequest } from "./utils";
import type { Storage } from "./storage";
import { createAdapter, type LLMAdapter } from "./adapters";

/**
 * VS Code Chat provider backed by OpenAI Custom Inference Providers.
 */
export class OpenAICustomChatModelProvider implements LanguageModelChatProvider {
  private _chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];
  /** model list */
  private _modelConfig: Map<string, OpenAICustomModelConfig> = new Map<string, OpenAICustomModelConfig>();
  /** Buffer for assembling streamed tool calls by index. */
  private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();

  /** Indices for which a tool call has been fully emitted. */
  private _completedToolCallIndices = new Set<number>();

  /** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
  private _hasEmittedAssistantText = false;

  /** Track if we emitted the begin-tool-calls whitespace flush. */
  private _emittedBeginToolCallsHint = false;

  // Lightweight tokenizer state for tool calls embedded in text
  private _textToolParserBuffer = "";
  private _textToolActive:
    | undefined
    | {
        name?: string;
        index?: number;
        argBuffer: string;
        emitted?: boolean;
      };
  private _emittedTextToolCallKeys = new Set<string>();
  private _emittedTextToolCallIds = new Set<string>();

  /**
   * Create a provider using the given storage for the config.
   * @param storage Storage.
   */
  constructor(
    private readonly storage: Storage,
    private readonly userAgent: string
  ) {}

  /** Roughly estimate tokens for VS Code chat messages (text only) */
  private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
    let total = 0;
    for (const m of msgs) {
      for (const part of m.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          total += Math.ceil(part.value.length / 4);
        }
      }
    }
    return total;
  }

  /** Rough token estimate for tool definitions by JSON size */
  private estimateToolTokens(
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
  ): number {
    if (!tools || tools.length === 0) {
      return 0;
    }
    try {
      const json = JSON.stringify(tools);
      return Math.ceil(json.length / 4);
    } catch {
      return 0;
    }
  }

  /**
   * Get the list of available language models contributed by this provider
   * @param options Options which specify the calling context of this function
   * @param token A cancellation token which signals if the user cancelled the request or not
   * @returns A promise that resolves to the list of available language models
   */
  async prepareLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken
  ): Promise<OpenAICustomLanguageModelChatInformation[]> {
    const configPath = await this.getConfigPath(options.silent);
    if (!configPath) {
      return [];
    }
    const configRaw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath as string));
    const configText = new TextDecoder().decode(configRaw);
    const configInfo = JSON.parse(configText) as { models: OpenAICustomModelConfig[] };
    const modelConfigTable = new Map<string, OpenAICustomModelConfig>();
    const modelChatInformationList: LanguageModelChatInformation[] = [];
    for (const modelConfig of configInfo.models) {
      let modelCategory: { label: string; order: number } | undefined;
      if (modelConfig.isDefault) {
        modelCategory = { label: "", order: Number.MIN_SAFE_INTEGER };
      } else {
        modelCategory = undefined;
      }
      const modelInfo: OpenAICustomLanguageModelChatInformation = {
        id: modelConfig.id,
        name: modelConfig.displayName,
        tooltip: modelConfig.tooltip,
        family: modelConfig.family,
        detail: "Cuntom",
        version: "1.0.0",
        maxInputTokens: modelConfig.maxInputTokens,
        maxOutputTokens: modelConfig.maxOutputTokens,
        isDefault: modelConfig.isDefault || false,
        modelCategory: modelCategory,
        capabilities: {
          toolCalling: modelConfig.capabilities.supports_tools,
          imageInput: modelConfig.capabilities.supports_image,
        },
      };
      modelChatInformationList.push(modelInfo);
      modelConfigTable.set(modelConfig.id, modelConfig);
    }
    if (modelChatInformationList.length === 0) {
      vscode.window.showWarningMessage(
        "OpenAI Custom models not found model in the configuration. please check your config file. " + configPath
      );
      return [];
    } else {
      this._modelConfig = modelConfigTable;
      return modelChatInformationList;
    }
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
  }

  async getConfigPath(silent: boolean): Promise<string | undefined> {
    const configPath = (await this.storage.getConfig()) as string | undefined;
    const ignore = silent === true ? true : true;
    if (!ignore) {
      return "";
    }
    if (!configPath) {
      await this.storage.showAndSetConfig();
    } else {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(configPath as string));
      } catch {
        await this.storage.showAndSetConfig();
      }
    }
    // double check
    const doubleConfigPath = (await this.storage.getConfig()) as string | undefined;
    if (!doubleConfigPath) {
      vscode.window.showWarningMessage("OpenAI Custom config path is not set.");
      return undefined;
    }
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(doubleConfigPath as string));
    } catch {
      vscode.window.showWarningMessage("OpenAI Custom config file not found at: " + doubleConfigPath);
      return undefined;
    }
    return doubleConfigPath as string;
  }

  /**
   * Returns the response for a chat request, passing the results to the progress callback.
   * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
   * @param model The language model to use
   * @param messages The messages to include in the request
   * @param options Options for the request
   * @param progress The progress to emit the streamed response chunks to
   * @param token A cancellation token for the request
   * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
   */
  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken
  ): Promise<void> {
    this._toolCallBuffers.clear();
    this._completedToolCallIndices.clear();
    this._hasEmittedAssistantText = false;
    this._emittedBeginToolCallsHint = false;
    this._textToolParserBuffer = "";
    this._textToolActive = undefined;
    this._emittedTextToolCallKeys.clear();
    this._emittedTextToolCallIds.clear();

    const trackingProgress: Progress<LanguageModelResponsePart> = {
      report: (part) => {
        try {
          progress.report(part);
        } catch (e) {
          console.error("[OpenAI Custom Model Provider] Progress.report failed", {
            modelId: model.id,
            error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
          });
        }
      },
    };
    try {
      const modelConfigInfo = this._modelConfig.get(model.id);
      if (!modelConfigInfo) {
        throw new Error("OpenAI Custom model config not found");
      }

      validateRequest(messages);

      if (options.tools && options.tools.length > 128) {
        throw new Error("Cannot have more than 128 tools per request.");
      }

      const inputTokenCount = this.estimateMessagesTokens(messages);
      const toolConfig = convertTools(options);
      const toolTokenCount = this.estimateToolTokens(toolConfig.tools);
      const tokenLimit = Math.max(1, model.maxInputTokens);
      if (inputTokenCount + toolTokenCount > tokenLimit) {
        console.error("[OpenAI Custom Model Provider] Message exceeds token limit", {
          total: inputTokenCount + toolTokenCount,
          tokenLimit,
        });
        throw new Error("Message exceeds token limit.");
      }

      // Create adapter and build request
      const adapter = createAdapter(modelConfigInfo);
      const { endpoint, body } = adapter.buildRequest(messages, options, modelConfigInfo);

      console.log("[OpenAI Custom Model Provider] Making request", {
        modelId: model.id,
        apiMode: modelConfigInfo.apiMode || "chat_completions",
        endpoint,
        hasTools: !!toolConfig.tools,
        toolCount: toolConfig.tools?.length ?? 0,
      });

      const response = await this.makeRequest(
        endpoint,
        modelConfigInfo.apiKey,
        body,
        modelConfigInfo.proxy,
        modelConfigInfo.ua
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[OpenAI Custom Model Provider] API error response", errorText);
        const lowerErrorText = errorText.toLowerCase();

        // Dynamic detection: some non-official Responses implementations do not support
        // the `previous_response_id` parameter and return a 400
        // "Unsupported parameter: previous_response_id". In that case, disable
        // stateful responses for this model and retry once without previous_response_id.
        if (
          modelConfigInfo.apiMode === "responses" &&
          (modelConfigInfo.supportsStatefulResponses ?? true) &&
          response.status === 400 &&
          lowerErrorText.includes("unsupported parameter") &&
          lowerErrorText.includes("previous_response_id")
        ) {
          console.log(
            "[OpenAI Custom Model Provider] previous_response_id not supported; retrying without stateful responses"
          );
          // Disable stateful for this model going forward.
          modelConfigInfo.supportsStatefulResponses = false;

          const statelessAdapter = createAdapter(modelConfigInfo);
          const statelessRequest = statelessAdapter.buildRequest(messages, options, modelConfigInfo);
          const statelessResponse = await this.makeRequest(
            statelessRequest.endpoint,
            modelConfigInfo.apiKey,
            statelessRequest.body,
            modelConfigInfo.proxy,
            modelConfigInfo.ua
          );

          if (!statelessResponse.ok) {
            const statelessErrorText = await statelessResponse.text();
            console.error("[OpenAI Custom Model Provider] Stateless retry API error response", statelessErrorText);
            throw new Error(
              `OpenAI Custom API error: ${statelessResponse.status} ${statelessResponse.statusText}${
                statelessErrorText ? `\n${statelessErrorText}` : ""
              }`
            );
          }

          if (!statelessResponse.body) {
            throw new Error("No response body from OpenAI Custom API (stateless retry)");
          }

          await this.processStreamingResponse(
            statelessResponse.body,
            trackingProgress,
            token,
            statelessAdapter,
            model.id
          );
          return;
        }

        // Check if we should fallback to chat_completions
        if (
          modelConfigInfo.apiMode === "responses" &&
          modelConfigInfo.fallbackToChatCompletions &&
          adapter.isUnsupportedError(response.status, errorText)
        ) {
          console.log("[OpenAI Custom Model Provider] Responses API not supported, falling back to chat_completions");
          vscode.window
            .showWarningMessage(
              "Responses API not supported by this service. Falling back to chat_completions.",
              "Don't show again"
            )
            .then((selection) => {
              if (selection === "Don't show again") {
                // User can update their config to avoid this fallback in the future
                console.log("[OpenAI Custom Model Provider] User dismissed fallback warning");
              }
            });

          // Retry with chat_completions adapter
          const fallbackConfig = { ...modelConfigInfo, apiMode: "chat_completions" as const };
          const fallbackAdapter = createAdapter(fallbackConfig);
          const fallbackRequest = fallbackAdapter.buildRequest(messages, options, fallbackConfig);

          const fallbackResponse = await this.makeRequest(
            fallbackRequest.endpoint,
            modelConfigInfo.apiKey,
            fallbackRequest.body,
            modelConfigInfo.proxy,
            modelConfigInfo.ua
          );

          if (!fallbackResponse.ok) {
            const fallbackErrorText = await fallbackResponse.text();
            console.error("[OpenAI Custom Model Provider] Fallback API error response", fallbackErrorText);
            throw new Error(
              `OpenAI Custom API error: ${fallbackResponse.status} ${fallbackResponse.statusText}${fallbackErrorText ? `\n${fallbackErrorText}` : ""}`
            );
          }

          if (!fallbackResponse.body) {
            throw new Error("No response body from OpenAI Custom API");
          }
          await this.processStreamingResponse(fallbackResponse.body, trackingProgress, token, fallbackAdapter, model.id);
          return;
        }

        throw new Error(
          `OpenAI Custom API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`
        );
      }

      if (!response.body) {
        throw new Error("No response body from OpenAI Custom API");
      }
      await this.processStreamingResponse(response.body, trackingProgress, token, adapter, model.id);
    } catch (err) {
      console.error("[OpenAI Custom Model Provider] Chat request failed", {
        modelId: model.id,
        messageCount: messages.length,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      throw err;
    }
  }

  /**
   * Make an HTTP request to the API
   */
  private async makeRequest(
    endpoint: string,
    apiKey: string,
    body: Record<string, unknown>,
    proxy?: string,
    userAgentOverride?: string
  ): Promise<Response> {
    const fetchOptions: any = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": userAgentOverride || this.userAgent,
      },
      body: JSON.stringify(body),
    };

    if (proxy) {
      fetchOptions.dispatcher = new ProxyAgent(proxy);
    }

    return (await fetch(endpoint, fetchOptions)) as Response;
  }

  /**
   * Returns the number of tokens for a given text using the model specific tokenizer logic
   * @param model The language model to use
   * @param text The text to count tokens for
   * @param token A cancellation token for the request
   * @returns A promise that resolves to the number of tokens
   */
  async provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken
  ): Promise<number> {
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    } else {
      let totalTokens = 0;
      for (const part of text.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          totalTokens += Math.ceil(part.value.length / 4);
        }
      }
      return totalTokens;
    }
  }

  /**
   * Read and parse the streaming (SSE-like) response and report parts.
   * @param responseBody The readable stream body.
   * @param progress Progress reporter for streamed parts.
   * @param token Cancellation token.
   * @param adapter The adapter to use for parsing events.
   */
  private async processStreamingResponse(
    responseBody: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    adapter: LLMAdapter,
    modelId: string
  ): Promise<void> {
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const event = adapter.parseStreamEvent(line);

          if (event.type === "skip") {
            continue;
          }

          if (event.type === "done") {
            // Flush any remaining tool call buffers
            await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
            await this.flushActiveTextToolCall(progress);
            continue;
          }

          if (event.type === "stateful_marker") {
            // 约定：`${modelId}\\${responseId}`（字符串中实际是单个反斜杠）
            const payload = `${modelId}\\${event.marker}`;
            progress.report(vscode.LanguageModelDataPart.text(payload, "stateful_marker"));
            await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
            await this.flushActiveTextToolCall(progress);
            continue;
          }

          if (event.type === "text") {
            const res = this.processTextContent(event.content, progress);
            if (res.emittedText) {
              this._hasEmittedAssistantText = true;
            }
          } else if (event.type === "thinking") {
            // Report thinking progress if host supports it
            try {
              const vsAny = vscode as unknown as Record<string, unknown>;
              const ThinkingCtor = vsAny["LanguageModelThinkingPart"] as
                | (new (text: string, id?: string, metadata?: unknown) => unknown)
                | undefined;
              if (ThinkingCtor) {
                progress.report(
                  new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(
                    event.text,
                    event.id,
                    event.metadata
                  ) as unknown as vscode.LanguageModelResponsePart
                );
              }
            } catch {
              // Ignore errors
            }
          } else if (event.type === "tool_call") {
            // Emit whitespace hint if this is the first tool call after text
            if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
              progress.report(new vscode.LanguageModelTextPart(" "));
              this._emittedBeginToolCallsHint = true;
            }

            // Ignore any further deltas for an index we've already completed
            if (this._completedToolCallIndices.has(event.index)) {
              continue;
            }

            const buf = this._toolCallBuffers.get(event.index) ?? { args: "" };
            if (event.id) {
              buf.id = event.id;
            }
            if (event.name) {
              buf.name = event.name;
            }
            if (event.args) {
              buf.args += event.args;
            }
            this._toolCallBuffers.set(event.index, buf);

            // Try to emit immediately once arguments become valid JSON
            await this.tryEmitBufferedToolCall(event.index, progress);
          } else if (event.type === "finish") {
            if (event.reason === "tool_calls" || event.reason === "stop") {
              await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      // Clean up any leftover tool call state
      this._toolCallBuffers.clear();
      this._completedToolCallIndices.clear();
      this._hasEmittedAssistantText = false;
      this._emittedBeginToolCallsHint = false;
      this._textToolParserBuffer = "";
      this._textToolActive = undefined;
      this._emittedTextToolCallKeys.clear();
    }
  }

  /**
   * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
   * Returns which parts were emitted for logging/flow control.
   */
  private processTextContent(
    input: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): { emittedText: boolean; emittedAny: boolean } {
    const BEGIN = "<|tool_call_begin|>";
    const ARG_BEGIN = "<|tool_call_argument_begin|>";
    const END = "<|tool_call_end|>";

    let data = this._textToolParserBuffer + input;
    let emittedText = false;
    let emittedAny = false;
    let visibleOut = "";

    while (data.length > 0) {
      if (!this._textToolActive) {
        const b = data.indexOf(BEGIN);
        if (b === -1) {
          // No tool-call start: emit visible portion, but keep any partial BEGIN prefix as buffer
          const longestPartialPrefix = ((): number => {
            for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
              if (data.endsWith(BEGIN.slice(0, k))) {
                return k;
              }
            }
            return 0;
          })();
          if (longestPartialPrefix > 0) {
            const visible = data.slice(0, data.length - longestPartialPrefix);
            if (visible) {
              visibleOut += this.stripControlTokens(visible);
            }
            this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
            data = "";
            break;
          } else {
            // All visible, clean other control tokens
            visibleOut += this.stripControlTokens(data);
            data = "";
            break;
          }
        }
        // Emit text before the token
        const pre = data.slice(0, b);
        if (pre) {
          visibleOut += this.stripControlTokens(pre);
        }
        // Advance past BEGIN
        data = data.slice(b + BEGIN.length);

        // Find the delimiter that ends the name/index segment
        const a = data.indexOf(ARG_BEGIN);
        const e = data.indexOf(END);
        let delimIdx = -1;
        let delimKind: "arg" | "end" | undefined = undefined;
        if (a !== -1 && (e === -1 || a < e)) {
          delimIdx = a;
          delimKind = "arg";
        } else if (e !== -1) {
          delimIdx = e;
          delimKind = "end";
        } else {
          // Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
          this._textToolParserBuffer = BEGIN + data;
          data = "";
          break;
        }

        const header = data.slice(0, delimIdx).trim();
        const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
        const name = m?.[1] ?? undefined;
        const index = m?.[2] ? Number(m?.[2]) : undefined;
        this._textToolActive = { name, index, argBuffer: "", emitted: false };
        // Advance past delimiter token
        if (delimKind === "arg") {
          data = data.slice(delimIdx + ARG_BEGIN.length);
        } /* end */ else {
          // No args, finalize immediately
          data = data.slice(delimIdx + END.length);
          const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}");
          if (did) {
            this._textToolActive.emitted = true;
            emittedAny = true;
          }
          this._textToolActive = undefined;
        }
        continue;
      }

      // We are inside arguments, collect until END and emit as soon as JSON becomes valid
      const e2 = data.indexOf(END);
      if (e2 === -1) {
        // No end marker yet, accumulate and check for early valid JSON
        this._textToolActive.argBuffer += data;
        // Early emit when JSON becomes valid and we haven't emitted yet
        if (!this._textToolActive.emitted) {
          const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
          if (did) {
            this._textToolActive.emitted = true;
            emittedAny = true;
          }
        }
        data = "";
        break;
      } else {
        this._textToolActive.argBuffer += data.slice(0, e2);
        // Consume END
        data = data.slice(e2 + END.length);
        // Final attempt to emit if not already
        if (!this._textToolActive.emitted) {
          const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
          if (did) {
            emittedAny = true;
          }
        }
        this._textToolActive = undefined;
        continue;
      }
    }

    // Emit any visible text
    const textToEmit = visibleOut;
    if (textToEmit && textToEmit.length > 0) {
      progress.report(new vscode.LanguageModelTextPart(textToEmit));
      emittedText = true;
      emittedAny = true;
    }

    // Store leftover for next chunk
    this._textToolParserBuffer = data;

    return { emittedText, emittedAny };
  }

  private emitTextToolCallIfValid(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
    argText: string
  ): boolean {
    const name = call.name ?? "unknown_tool";
    const parsed = tryParseJSONObject(argText);
    if (!parsed.ok) {
      return false;
    }
    const canonical = JSON.stringify(parsed.value);
    const key = `${name}:${canonical}`;
    // identity-based dedupe when index is present
    if (typeof call.index === "number") {
      const idKey = `${name}:${call.index}`;
      if (this._emittedTextToolCallIds.has(idKey)) {
        return false;
      }
      // Mark identity as emitted
      this._emittedTextToolCallIds.add(idKey);
    } else if (this._emittedTextToolCallKeys.has(key)) {
      return false;
    }
    this._emittedTextToolCallKeys.add(key);
    const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
    progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
    return true;
  }

  private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
    if (!this._textToolActive) {
      return;
    }
    const argText = this._textToolActive.argBuffer;
    const parsed = tryParseJSONObject(argText);
    if (!parsed.ok) {
      return;
    }
    // Emit (dedupe ensures we don't double-emit)
    this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
    this._textToolActive = undefined;
  }

  /**
   * Try to emit a buffered tool call when a valid name and JSON arguments are available.
   * @param index The tool call index from the stream.
   * @param progress Progress reporter for parts.
   */
  private async tryEmitBufferedToolCall(
    index: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    const buf = this._toolCallBuffers.get(index);
    if (!buf) {
      return;
    }
    if (!buf.name) {
      return;
    }
    const canParse = tryParseJSONObject(buf.args);
    if (!canParse.ok) {
      return;
    }
    const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
    const parameters = canParse.value;
    try {
      const canonical = JSON.stringify(parameters);
      this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
    } catch {
      /* ignore */
    }
    progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
    this._toolCallBuffers.delete(index);
    this._completedToolCallIndices.add(index);
  }

  /**
   * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
   * @param progress Progress reporter for parts.
   * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
   */
  private async flushToolCallBuffers(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    throwOnInvalid: boolean
  ): Promise<void> {
    if (this._toolCallBuffers.size === 0) {
      return;
    }
    for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
      const parsed = tryParseJSONObject(buf.args);
      if (!parsed.ok) {
        if (throwOnInvalid) {
          console.error("[OpenAI Custom Model Provider] Invalid JSON for tool call", {
            idx,
            snippet: (buf.args || "").slice(0, 200),
          });
          throw new Error("Invalid JSON for tool call");
        }
        // When not throwing (e.g. on [DONE]), drop silently to reduce noise
        continue;
      }
      const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      const name = buf.name ?? "unknown_tool";
      try {
        const canonical = JSON.stringify(parsed.value);
        this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
      } catch {
        /* ignore */
      }
      progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
      this._toolCallBuffers.delete(idx);
      this._completedToolCallIndices.add(idx);
    }
  }

  /** Strip provider control tokens like <|tool_calls_section_begin|> and <|tool_call_begin|> from streamed text. */
  private stripControlTokens(text: string): string {
    try {
      // Remove section markers and explicit tool call begin/argument/end markers that some backends stream as text
      return text
        .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
        .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
    } catch {
      return text;
    }
  }
}
