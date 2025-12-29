import * as vscode from "vscode";
import type {
  OpenAICustomModelConfig,
  ResponsesItem,
  ResponsesMessageItem,
  ResponsesContentItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
} from "./types";
import { convertMessages, convertTools, convertToolsForResponses } from "./utils";

// Constants for ID generation
const CALL_ID_SUFFIX_LENGTH = 8;

/**
 * Base adapter interface for LLM APIs
 */
export interface LLMAdapter {
  /**
   * Build the request body for the API
   */
  buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: OpenAICustomModelConfig
  ): { endpoint: string; body: Record<string, unknown> };

  /**
   * Parse a streaming event line
   */
  parseStreamEvent(line: string): StreamEventResult;

  /**
   * Check if an error response suggests the API is not supported
   */
  isUnsupportedError(status: number, errorText: string): boolean;
}

export type StreamEventResult =
  | { type: "text"; content: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; args?: string }
  | { type: "thinking"; text: string; id?: string; metadata?: unknown }
  | { type: "stateful_marker"; marker: string }
  | { type: "finish"; reason: string }
  | { type: "done" }
  | { type: "skip" };

/**
 * Adapter for OpenAI Chat Completions API
 */
export class ChatCompletionsAdapter implements LLMAdapter {
  buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: OpenAICustomModelConfig
  ): { endpoint: string; body: Record<string, unknown> } {
    const openaiMessages = convertMessages(messages, config);
    const toolConfig = convertTools(options);

    // Build base URL - ensure we append /chat/completions if not already present
    let endpoint = config.baseUrl;
    if (!endpoint.endsWith("/chat/completions")) {
      // Remove trailing slash if present
      endpoint = endpoint.replace(/\/$/, "");
      // If baseUrl ends with /v1, append /chat/completions
      if (endpoint.endsWith("/v1")) {
        endpoint = `${endpoint}/chat/completions`;
      } else {
        // Otherwise, check if we need to add /v1/chat/completions
        if (!endpoint.includes("/v1")) {
          endpoint = `${endpoint}/v1/chat/completions`;
        } else {
          endpoint = `${endpoint}/chat/completions`;
        }
      }
    }

    const body: Record<string, unknown> = {
      model: config.modelName,
      messages: openaiMessages,
      stream: true,
      max_tokens: Math.min(options.modelOptions?.max_tokens || 4096, config.maxOutputTokens),
      temperature: options.modelOptions?.temperature ?? 0.7,
    };

    // Add model options
    if (options.modelOptions) {
      const mo = options.modelOptions as Record<string, unknown>;
      if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
        body.stop = mo.stop;
      }
      if (typeof mo.frequency_penalty === "number") {
        body.frequency_penalty = mo.frequency_penalty;
      }
      if (typeof mo.presence_penalty === "number") {
        body.presence_penalty = mo.presence_penalty;
      }
    }

    // Add tools
    if (toolConfig.tools) {
      body.tools = toolConfig.tools;
    }
    if (toolConfig.tool_choice) {
      body.tool_choice = toolConfig.tool_choice;
    }

    return { endpoint, body };
  }

  parseStreamEvent(line: string): StreamEventResult {
    if (!line.startsWith("data:")) {
      return { type: "skip" };
    }

    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      return { type: "done" };
    }

    try {
      const parsed = JSON.parse(data);
      const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) {
        return { type: "skip" };
      }

      const deltaObj = choice.delta as Record<string, unknown> | undefined;

      // Handle thinking/reasoning content
      const maybeThinking =
        (choice as Record<string, unknown>)?.reasoning_content ??
        (deltaObj as Record<string, unknown>)?.reasoning_content;
      if (maybeThinking !== undefined) {
        let text = "";
        let id: string | undefined;
        let metadata: unknown;
        if (maybeThinking && typeof maybeThinking === "object") {
          const mt = maybeThinking as Record<string, unknown>;
          text = typeof mt.text === "string" ? mt.text : "";
          id = typeof mt.id === "string" ? mt.id : undefined;
          metadata = mt.metadata;
        } else if (typeof maybeThinking === "string") {
          text = maybeThinking;
        }
        if (text) {
          return { type: "thinking", text, id, metadata };
        }
      }

      // Handle text content
      if (deltaObj?.content) {
        return { type: "text", content: String(deltaObj.content) };
      }

      // Handle tool calls
      if (deltaObj?.tool_calls) {
        const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;
        if (toolCalls.length > 0) {
          const tc = toolCalls[0];
          const idx = (tc.index as number) ?? 0;
          const func = tc.function as Record<string, unknown> | undefined;
          return {
            type: "tool_call",
            index: idx,
            id: typeof tc.id === "string" ? tc.id : undefined,
            name: typeof func?.name === "string" ? func.name : undefined,
            args: typeof func?.arguments === "string" ? func.arguments : undefined,
          };
        }
      }

      // Handle finish reason
      const finish = (choice.finish_reason as string | undefined) ?? undefined;
      if (finish) {
        return { type: "finish", reason: finish };
      }

      return { type: "skip" };
    } catch {
      return { type: "skip" };
    }
  }

  isUnsupportedError(_status: number, _errorText: string): boolean {
    // Chat Completions is the default, so it's always supported
    return false;
  }
}

/**
 * Adapter for OpenAI Responses API
 */
export class ResponsesAdapter implements LLMAdapter {
  private _toolCallIndexById = new Map<string, number>();
  private _nextToolCallIndex = 0;
  private _sawOutputTextDelta = false;
  /** Last seen SSE event type (from `event:` line). */
  private _lastSseEventType: string | undefined;
  private _emittedTextItemKeys = new Set<string>();

  private getToolCallIndex(callId: string | undefined): number {
    if (!callId) {
      return 0;
    }
    const existing = this._toolCallIndexById.get(callId);
    if (existing !== undefined) {
      return existing;
    }
    const idx = this._nextToolCallIndex++;
    this._toolCallIndexById.set(callId, idx);
    return idx;
  }

  buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: OpenAICustomModelConfig
  ): { endpoint: string; body: Record<string, unknown> } {
    // 支持 stateful：从最近一次 stateful_marker 里提取 previous_response_id，并仅发送 marker 之后的对话。
    // 一些非官方实现不支持该参数，会返回 400 Unsupported parameter: previous_response_id，
    // 因此可以通过 config.supportsStatefulResponses 显式关闭。
    const supportsStateful = config.supportsStatefulResponses !== false;
    const stateful = supportsStateful ? this.extractPreviousResponseId(messages, config.id) : undefined;
    const effectiveMessages = stateful ? messages.slice(stateful.sliceFromMessageIndex) : messages;

    // Convert messages to Responses API items（system 也作为 message item 发送，贴近官方实现）
    const items = this.convertMessagesToItems(effectiveMessages, config);

    // Responses API tools/tool_choice 结构与 chat.completions 不同
    const toolConfig = convertToolsForResponses(options);

    // Build endpoint
    let endpoint = config.baseUrl;
    if (!endpoint.endsWith("/responses")) {
      endpoint = endpoint.replace(/\/$/, "");
      if (endpoint.endsWith("/v1")) {
        endpoint = `${endpoint}/responses`;
      } else if (!endpoint.includes("/v1")) {
        endpoint = `${endpoint}/v1/responses`;
      } else {
        endpoint = `${endpoint}/responses`;
      }
    }

    const body: Record<string, unknown> = {
      model: config.modelName,
      input: items,
      stream: true,
      max_output_tokens: Math.min(options.modelOptions?.max_tokens || 4096, config.maxOutputTokens),
      temperature: options.modelOptions?.temperature ?? 0.7,
      // 对齐官方默认：不存储
      store: false,
      // 对齐官方默认：包含加密 reasoning（如果服务端支持）
      include: ["reasoning.encrypted_content"],
    };

    if (supportsStateful && stateful?.previous_response_id) {
      body.previous_response_id = stateful.previous_response_id;
    }

    // Add reasoning config if configured
    if (config.reasoning?.effort || config.reasoning?.summary) {
      body.reasoning = {
        ...(config.reasoning?.effort ? { effort: config.reasoning.effort } : {}),
        ...(config.reasoning?.summary ? { summary: config.reasoning.summary } : {}),
      };
    }

    // Add truncation config if configured
    if (config.truncation) {
      body.truncation = config.truncation;
    }

    // Add text verbosity config if configured
    if (config.text?.verbosity) {
      body.text = { verbosity: config.text.verbosity };
    }

    // Add tools
    if (toolConfig.tools) {
      body.tools = toolConfig.tools;
    }

    // Map tool_choice
    if (config.toolChoice === "none") {
      body.tool_choice = "none";
    } else if (config.toolChoice === "required") {
      if (toolConfig.tools && toolConfig.tools.length === 1) {
        body.tool_choice = { type: "function", name: toolConfig.tools[0].name };
      } else {
        body.tool_choice = "required";
      }
    } else if (toolConfig.tool_choice) {
      body.tool_choice = toolConfig.tool_choice;
    }

    // Add parallel tool calls setting
    if (config.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = config.parallelToolCalls;
    }

    // Add model options
    if (options.modelOptions) {
      const mo = options.modelOptions as Record<string, unknown>;

      // top_logprobs: align with Copilot default (request logprobs -> top_logprobs=3)
      const wantsLogprobs =
        mo.logprobs === true || mo.logprobs === 1 || (typeof mo.logprobs === "number" && mo.logprobs > 0);
      if (wantsLogprobs) {
        body.top_logprobs = typeof mo.top_logprobs === "number" ? mo.top_logprobs : 3;
      }

      // Allow per-request overrides for truncation/text/reasoning summary via modelOptions (if provided)
      if (typeof mo.truncation === "string" && (mo.truncation === "auto" || mo.truncation === "disabled")) {
        body.truncation = mo.truncation;
      }
      const moText = mo.text as unknown;
      const moVerbosity =
        (moText && typeof moText === "object" ? (moText as Record<string, unknown>).verbosity : undefined) ?? mo.verbosity;
      if (
        typeof moVerbosity === "string" &&
        (moVerbosity === "low" || moVerbosity === "medium" || moVerbosity === "high")
      ) {
        body.text = { verbosity: moVerbosity };
      }
      const moReasoning = mo.reasoning as unknown;
      const moSummary =
        moReasoning && typeof moReasoning === "object" ? (moReasoning as Record<string, unknown>).summary : undefined;
      if (typeof moSummary === "string" && (moSummary === "auto" || moSummary === "none")) {
        const existing = (body.reasoning as Record<string, unknown> | undefined) ?? {};
        body.reasoning = { ...existing, summary: moSummary };
      }

      if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
        body.stop = mo.stop;
      }
      if (typeof mo.frequency_penalty === "number") {
        body.frequency_penalty = mo.frequency_penalty;
      }
      if (typeof mo.presence_penalty === "number") {
        body.presence_penalty = mo.presence_penalty;
      }
    }

    return { endpoint, body };
  }

  private extractPreviousResponseId(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelId: string
  ): { previous_response_id: string; sliceFromMessageIndex: number } | undefined {
    // 约定：stateful_marker 的 data 文本为 `${modelId}\\${responseId}`（字符串里实际是单个反斜杠）
    // 我们选择“最后一个匹配 marker”为准。
    const decoder = new TextDecoder();
    let last: { previous_response_id: string; sliceFromMessageIndex: number } | undefined;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      for (const part of msg.content ?? []) {
        if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "stateful_marker") {
          let raw = "";
          try {
            raw = decoder.decode(part.data);
          } catch {
            continue;
          }
          const sep = raw.indexOf("\\");
          if (sep <= 0) {
            continue;
          }
          const mid = raw.slice(0, sep);
          const marker = raw.slice(sep + 1);
          if (!mid || !marker) {
            continue;
          }
          if (mid !== modelId) {
            continue;
          }
          last = { previous_response_id: marker, sliceFromMessageIndex: i + 1 };
        }
      }
    }

    return last;
  }

  private convertMessagesToItems(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    config: OpenAICustomModelConfig
  ): ResponsesItem[] {
    const items: ResponsesItem[] = [];
    const supportsSystem = config.supportsSystemRole !== false;

    // 将 config.instructions 作为首条 message 注入 input：
    // - 支持 system role 时：role=system
    // - 不支持时：降级为 user，并在文本前加 "[System]:" 前缀，避免触发后端的 system 限制
    if (config.instructions?.trim()) {
      const raw = config.instructions.trim();
      const role: "system" | "user" = supportsSystem ? "system" : "user";
      const text = supportsSystem ? raw : `[System]: ${raw}`;
      items.push({
        type: "message",
        role,
        content: [{ type: "input_text", text }],
      });
    }

    for (const msg of messages) {
      let pendingText = "";
      const contentItems: ResponsesContentItem[] = [];
      const toolCalls: ResponsesFunctionCallItem[] = [];
      const toolResults: Array<ResponsesFunctionCallOutputItem | ResponsesMessageItem> = [];

      for (const part of msg.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          pendingText += part.value;
        } else if (part instanceof vscode.LanguageModelDataPart) {
          // Ignore stateful markers inside the request window; they are handled separately for stateful slicing.
          if (part.mimeType === "stateful_marker") {
            continue;
          }
          // Images are encoded as data URLs for Responses input_image.
          const url = this.tryDataPartToDataUrl(part);
          if (!url) {
            continue;
          }
          // Only user/system can carry input_image content items.
          if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
            continue;
          }
          if (pendingText) {
            contentItems.push({ type: "input_text", text: pendingText });
            pendingText = "";
          }
          contentItems.push({ type: "input_image", image_url: url });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const callId =
            part.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 2 + CALL_ID_SUFFIX_LENGTH)}`;
          let args = "{}";
          try {
            args = JSON.stringify(part.input ?? {});
          } catch {
            args = "{}";
          }
          toolCalls.push({
            type: "function_call",
            call_id: callId,
            name: part.name,
            arguments: args,
          });
        } else if (this.isToolResultPart(part)) {
          const callId = (part as { callId?: string }).callId ?? "";
          const collected = this.collectToolResultTextAndImages(part as { content?: ReadonlyArray<unknown> });
          toolResults.push({
            type: "function_call_output",
            call_id: callId,
            output: collected.text,
          });

          // Copilot-style hack: Responses `function_call_output` only carries text; images are added as a separate user message.
          for (const url of collected.imageUrls) {
            toolResults.push({
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Image associated with tool output." },
                { type: "input_image", image_url: url },
              ],
            });
          }
        }
      }

      // Map role
      let role: "user" | "assistant" | "system" = "user";
      if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = "assistant";
      } else if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        role = "user";
      } else {
        role = "system";
      }
      // 对不支持 system role 的后端，将 system 消息降级为 user，并加前缀
      let needsSystemPrefix = false;
      if (role === "system" && !supportsSystem) {
        role = "user";
        needsSystemPrefix = true;
      }

      if (pendingText) {
        let text = pendingText;
        if (needsSystemPrefix && text) {
          text = `[System]: ${text}`;
          needsSystemPrefix = false;
        }
        contentItems.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        });
        pendingText = "";
      }

      if (contentItems.length > 0) {
        if (needsSystemPrefix) {
          contentItems.unshift({
            type: "input_text",
            text: "[System]:",
          });
          needsSystemPrefix = false;
        }
        // Ensure assistant messages always use output_text items.
        if (role === "assistant") {
          const normalized: ResponsesContentItem[] = contentItems.map((c) =>
            c.type === "output_text" ? c : { type: "output_text" as const, text: c.text }
          );
          items.push({ type: "message", role, content: normalized });
        } else {
          items.push({ type: "message", role, content: contentItems });
        }
      }

      // Add tool calls
      for (const tc of toolCalls) {
        items.push(tc);
      }

      // Add tool results (+ any image hack messages)
      for (const tr of toolResults) {
        items.push(tr);
      }
    }

    return items;
  }

  private tryDataPartToDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
    const mime = part.mimeType || "";
    if (!mime.startsWith("image/")) {
      return undefined;
    }
    try {
      const base64 = Buffer.from(part.data).toString("base64");
      return `data:${mime};base64,${base64}`;
    } catch {
      return undefined;
    }
  }

  parseStreamEvent(line: string): StreamEventResult {
    // Support SSE `event:` lines in addition to JSON `type` field.
    // We follow the Copilot logic: prefer SSE event type when it is
    // present and not the default `"message"`, otherwise fall back to
    // the JSON `type` field inside the payload.
    if (line.startsWith("event:")) {
      const ev = line.slice(6).trim();
      this._lastSseEventType = ev || "message";
      return { type: "skip" };
    }

    if (!line.startsWith("data:")) {
      return { type: "skip" };
    }

    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      return { type: "done" };
    }

    try {
      const parsed = JSON.parse(data);

      // Handle different event types in Responses API
      // The structure might be: { type: "response.output_text.delta", delta: { text: "..." } }
      // Or: { type: "response.function_call.delta", delta: { call_id, name, arguments } }
      // Or: { type: "response.output_item.added", item: { type: "function_call", ... } }
      // Or: { type: "response.done" }
      // Or it might follow the same structure as chat completions with output array

      const jsonType = typeof (parsed as Record<string, unknown>).type === "string" ? (parsed as Record<string, string>).type : undefined;
      const sseType = this._lastSseEventType;
      const eventType = sseType && sseType !== "message" ? sseType : jsonType;

      if (eventType === "response.completed") {
        const resp = (parsed as Record<string, unknown>).response as unknown;
        const rid =
          (resp && typeof resp === "object" && typeof (resp as Record<string, unknown>).id === "string"
            ? String((resp as Record<string, unknown>).id)
            : undefined) ??
          (typeof (parsed as Record<string, unknown>).id === "string" ? String((parsed as Record<string, unknown>).id) : undefined);
        if (rid) {
          return { type: "stateful_marker", marker: rid };
        }
        return { type: "done" };
      }

      if (eventType === "response.done") {
        return { type: "done" };
      }

      if (eventType === "response.output_text.delta") {
        const delta = parsed.delta as unknown;
        const text =
          (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).text === "string"
            ? String((delta as Record<string, unknown>).text)
            : undefined) ?? (typeof delta === "string" ? delta : undefined);
        if (text) {
          this._sawOutputTextDelta = true;
          return { type: "text", content: text };
        }
      }

      if (eventType === "response.output_text.done") {
        if (this._sawOutputTextDelta) {
          return { type: "skip" };
        }
        const delta = parsed.delta as unknown;
        const text =
          (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).text === "string"
            ? String((delta as Record<string, unknown>).text)
            : undefined) ??
          (typeof delta === "string" ? delta : undefined) ??
          (typeof (parsed as Record<string, unknown>).text === "string"
            ? String((parsed as Record<string, unknown>).text)
            : undefined);
        if (text) {
          return { type: "text", content: text };
        }
      }

      if (
        eventType === "response.reasoning_summary.delta" ||
        eventType === "response.reasoning_summary.done" ||
        eventType === "response.reasoning.delta" ||
        eventType === "response.reasoning.done"
      ) {
        const p = parsed as Record<string, unknown>;
        const delta = p.delta ?? p.reasoning_summary ?? p.reasoning ?? p.summary;
        const d = delta && typeof delta === "object" ? (delta as Record<string, unknown>) : undefined;
        const text =
          (typeof d?.text === "string" ? d.text : undefined) ??
          (typeof delta === "string" ? delta : undefined) ??
          (typeof p.text === "string" ? p.text : undefined);
        const id =
          (typeof d?.id === "string" ? d.id : undefined) ??
          (typeof p.item_id === "string" ? p.item_id : undefined) ??
          (typeof p.id === "string" ? p.id : undefined);
        if (text) {
          return { type: "thinking", text, id };
        }
      }

      if (eventType === "response.function_call.delta" || eventType === "response.function_call_arguments.delta") {
        const delta = parsed.delta as unknown;
        const d = (delta && typeof delta === "object" ? (delta as Record<string, unknown>) : undefined) ?? undefined;
        const callId =
          (typeof d?.call_id === "string" ? d.call_id : undefined) ??
          (typeof (parsed as Record<string, unknown>).call_id === "string"
            ? String((parsed as Record<string, unknown>).call_id)
            : undefined);
        const argsRaw = d?.arguments ?? d?.delta ?? (typeof delta === "string" ? delta : undefined);
        let args: string | undefined;
        if (typeof argsRaw === "string") {
          args = argsRaw;
        } else if (argsRaw && typeof argsRaw === "object") {
          try {
            args = JSON.stringify(argsRaw);
          } catch {
            args = undefined;
          }
        }
        return {
          type: "tool_call",
          index: this.getToolCallIndex(callId),
          id: callId,
          name: typeof d?.name === "string" ? d.name : undefined,
          args,
        };
      }

      if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
        const p = parsed as Record<string, unknown>;
        const item = (p.item as unknown) ?? (p.output_item as unknown);
        if (item && typeof item === "object") {
          const it = item as Record<string, unknown>;
          if (it.type === "function_call") {
            const callId = typeof it.call_id === "string" ? it.call_id : undefined;
            const argsRaw = it.arguments as unknown;
            let args: string | undefined;
            if (typeof argsRaw === "string") {
              args = argsRaw;
            } else if (argsRaw && typeof argsRaw === "object") {
              try {
                args = JSON.stringify(argsRaw);
              } catch {
                args = undefined;
              }
            }
            return {
              type: "tool_call",
              index: this.getToolCallIndex(callId),
              id: callId,
              name: typeof it.name === "string" ? it.name : undefined,
              args,
            };
          }

          if (!this._sawOutputTextDelta) {
            if (it.type === "output_text") {
              const t = typeof it.text === "string" ? it.text : undefined;
              if (t) {
                const key =
                  (typeof it.id === "string" ? it.id : undefined) ??
                  (typeof p.output_index === "number" ? `output_index:${p.output_index}` : undefined);
                if (key && this._emittedTextItemKeys.has(key)) {
                  return { type: "skip" };
                }
                if (key) {
                  this._emittedTextItemKeys.add(key);
                }
                return { type: "text", content: t };
              }
            }
            if (it.type === "message") {
              const content = it.content as unknown;
              if (Array.isArray(content)) {
                const first = content.find(
                  (c) =>
                    c &&
                    typeof c === "object" &&
                    (c as Record<string, unknown>).type === "output_text" &&
                    typeof (c as Record<string, unknown>).text === "string" &&
                    Boolean((c as Record<string, unknown>).text)
                ) as Record<string, unknown> | undefined;
                const t = first && typeof first.text === "string" ? first.text : undefined;
                if (t) {
                  const key =
                    (typeof it.id === "string" ? it.id : undefined) ??
                    (typeof p.output_index === "number" ? `output_index:${p.output_index}` : undefined);
                  if (key && this._emittedTextItemKeys.has(key)) {
                    return { type: "skip" };
                  }
                  if (key) {
                    this._emittedTextItemKeys.add(key);
                  }
                  return { type: "text", content: t };
                }
              }
            }
          }
        }
      }

      // Fallback: try to parse as similar to chat completions format
      // Some implementations might return output array in the response
      const output = parsed.output as ResponsesItem[] | undefined;
      if (output && Array.isArray(output) && output.length > 0) {
        const lastItem = output[output.length - 1];
        if (!this._sawOutputTextDelta && lastItem.type === "output_text" && "text" in lastItem && lastItem.text) {
          return { type: "text", content: lastItem.text };
        }
        if (!this._sawOutputTextDelta && lastItem.type === "message") {
          const msg = lastItem as ResponsesMessageItem;
          const t =
            msg.content?.find((c) => c.type === "output_text" && typeof c.text === "string" && Boolean(c.text))?.text ??
            undefined;
          if (t) {
            return { type: "text", content: t };
          }
        }
        if (lastItem.type === "function_call") {
          const fc = lastItem as ResponsesFunctionCallItem;
          return {
            type: "tool_call",
            index: this.getToolCallIndex(fc.call_id),
            id: fc.call_id,
            name: fc.name,
            args: fc.arguments,
          };
        }
      }

      return { type: "skip" };
    } catch {
      return { type: "skip" };
    }
  }

  isUnsupportedError(status: number, errorText: string): boolean {
    // Check for common "not supported" error patterns
    if (status === 404 || status === 405 || status === 501) {
      return true;
    }
    const lowerError = errorText.toLowerCase();
    return (
      lowerError.includes("not found") ||
      lowerError.includes("not supported") ||
      lowerError.includes("not implemented") ||
      lowerError.includes("unknown endpoint")
    );
  }

  private isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
    if (!value || typeof value !== "object") {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return typeof obj.callId === "string" && "content" in obj;
  }

  private collectToolResultTextAndImages(pr: {
    content?: ReadonlyArray<unknown>;
  }): { text: string; imageUrls: string[] } {
    let text = "";
    const imageUrls: string[] = [];
    for (const c of pr.content ?? []) {
      if (c instanceof vscode.LanguageModelTextPart) {
        text += c.value;
      } else if (c instanceof vscode.LanguageModelDataPart) {
        const url = this.tryDataPartToDataUrl(c);
        if (url) {
          imageUrls.push(url);
        }
      } else if (typeof c === "string") {
        text += c;
      } else {
        try {
          text += JSON.stringify(c);
        } catch {
          /* ignore */
        }
      }
    }
    return { text, imageUrls };
  }
}

/**
 * Factory function to create the appropriate adapter based on config
 */
export function createAdapter(config: OpenAICustomModelConfig): LLMAdapter {
  if (config.apiMode === "responses") {
    return new ResponsesAdapter();
  }
  return new ChatCompletionsAdapter();
}
