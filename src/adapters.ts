import * as vscode from "vscode";
import type {
  OpenAICustomModelConfig,
  ResponsesItem,
  ResponsesContentItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
} from "./types";
import { convertMessages, convertTools } from "./utils";

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
    const openaiMessages = convertMessages(messages);
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
  buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: OpenAICustomModelConfig
  ): { endpoint: string; body: Record<string, unknown> } {
    // Convert messages to Responses API items
    const items = this.convertMessagesToItems(messages);

    // Map instructions to a system message to avoid providers that reject the top-level instructions field
    if (config.instructions?.trim()) {
      items.unshift({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: config.instructions.trim() }],
      });
    }
    const toolConfig = convertTools(options);

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
    };

    // Add reasoning effort if configured
    if (config.reasoning?.effort) {
      body.reasoning = { effort: config.reasoning.effort };
    }

    // Add tools
    if (toolConfig.tools) {
      body.tools = toolConfig.tools;
    }

    // Map tool_choice
    if (config.toolChoice === "none") {
      body.tool_choice = "none";
    } else if (config.toolChoice === "required" && toolConfig.tools && toolConfig.tools.length === 1) {
      body.tool_choice = { type: "function", function: { name: toolConfig.tools[0].function.name } };
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

  private convertMessagesToItems(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesItem[] {
    const items: ResponsesItem[] = [];

    for (const msg of messages) {
      const textParts: string[] = [];
      const toolCalls: ResponsesFunctionCallItem[] = [];
      const toolResults: ResponsesFunctionCallOutputItem[] = [];

      for (const part of msg.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const callId = part.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 2 + CALL_ID_SUFFIX_LENGTH)}`;
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
          const content = this.collectToolResultText(part as { content?: ReadonlyArray<unknown> });
          toolResults.push({
            type: "function_call_output",
            call_id: callId,
            output: content,
          });
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

      // Add text message if there's text content
      const text = textParts.join("");
      if (text) {
        const contentItems: ResponsesContentItem[] = [
          {
            type: role === "assistant" ? "output_text" : "input_text",
            text: text,
          },
        ];
        items.push({
          type: "message",
          role,
          content: contentItems,
        });
      }

      // Add tool calls
      for (const tc of toolCalls) {
        items.push(tc);
      }

      // Add tool results
      for (const tr of toolResults) {
        items.push(tr);
      }
    }

    return items;
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

      // Handle different event types in Responses API
      // The structure might be: { type: "response.output_text.delta", delta: { text: "..." } }
      // Or: { type: "response.done" }
      // Or it might follow the same structure as chat completions with output array

      const eventType = parsed.type as string | undefined;

      if (eventType === "response.done") {
        return { type: "done" };
      }

      if (eventType === "response.output_text.delta") {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta?.text && typeof delta.text === "string") {
          return { type: "text", content: delta.text };
        }
      }

      if (eventType === "response.function_call.delta") {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        return {
          type: "tool_call",
          index: 0,
          id: typeof delta?.call_id === "string" ? delta.call_id : undefined,
          name: typeof delta?.name === "string" ? delta.name : undefined,
          args: typeof delta?.arguments === "string" ? delta.arguments : undefined,
        };
      }

      // Fallback: try to parse as similar to chat completions format
      // Some implementations might return output array in the response
      const output = parsed.output as ResponsesItem[] | undefined;
      if (output && Array.isArray(output) && output.length > 0) {
        const lastItem = output[output.length - 1];
        if (lastItem.type === "output_text" && "text" in lastItem && lastItem.text) {
          return { type: "text", content: lastItem.text };
        }
        if (lastItem.type === "function_call") {
          const fc = lastItem as ResponsesFunctionCallItem;
          return {
            type: "tool_call",
            index: 0,
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

  private collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
    let text = "";
    for (const c of pr.content ?? []) {
      if (c instanceof vscode.LanguageModelTextPart) {
        text += c.value;
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
    return text;
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
