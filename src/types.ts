import { LanguageModelChatInformation } from "vscode";

/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

/**
 * OpenAI-style chat message used for router requests.
 */
export interface OpenAIChatMessage {
  role: OpenAIChatRole;
  content?: string;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/**
 * Buffer used to accumulate streamed tool call parts until arguments are valid JSON.
 */
export interface ToolCallBuffer {
  id?: string;
  name?: string;
  args: string;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

export interface OpenAICustomLanguageModelChatInformation extends LanguageModelChatInformation {
  isDefault?: boolean;
  modelCategory?: { label: string; order: number };
}

/** OpenAI Custom model config */
export interface OpenAICustomModelConfig {
  id: string;
  displayName: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  family: string;
  tooltip?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  context_length: number;
  isDefault?: boolean;
  capabilities: {
    supports_tools?: boolean;
    supports_image?: boolean;
  };
}
