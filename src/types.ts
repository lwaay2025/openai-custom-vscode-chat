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
 * OpenAI Responses API 的 function tool 定义（与 chat.completions 的 tools 结构不同）。
 * 参考：Responses API tools/function 以 name/parameters/strict 为顶层字段。
 */
export interface OpenAIResponsesFunctionToolDef {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
  strict?: boolean;
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
  // New fields for Responses API support
  apiMode?: "chat_completions" | "responses";
  instructions?: string;
  reasoning?: {
    effort?: "low" | "medium" | "high";
    summary?: "auto" | "none";
  };
  toolChoice?: "auto" | "none" | "required";
  parallelToolCalls?: boolean;
  fallbackToChatCompletions?: boolean;
  supportsSystemRole?: boolean;
  /**
   * Whether the upstream Responses API implementation supports stateful
   * conversations via `previous_response_id`.
   * When set to false, stateful markers are ignored and the parameter
   * is not sent to avoid 400 errors from providers that don't support it.
   */
  supportsStatefulResponses?: boolean;
  proxy?: string;
  /**
   * Responses API truncation mode.
   * When set, forwarded as `truncation` in the request body.
   */
  truncation?: "auto" | "disabled";
  /**
   * Responses API text configuration.
   * When set, forwarded as `text` in the request body.
   */
  text?: {
    verbosity?: "low" | "medium" | "high";
  };
}

/**
 * OpenAI Responses API Item types
 */
export type ResponsesItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesOutputTextItem;

export interface ResponsesMessageItem {
  type: "message";
  role: "user" | "assistant" | "system";
  content: ResponsesContentItem[];
}

export interface ResponsesContentItem {
  type: "input_text" | "output_text" | "input_image";
  text?: string;
  image_url?: string;
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponsesOutputTextItem {
  type: "output_text";
  text?: string;
}

/**
 * OpenAI Responses API request body
 */
export interface ResponsesAPIRequest {
  model: string;
  input: ResponsesItem[];
  tools?: OpenAIResponsesFunctionToolDef[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  previous_response_id?: string;
  reasoning?: {
    effort?: "low" | "medium" | "high";
    summary?: "auto" | "none";
  };
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  store?: boolean;
  include?: string[];
  truncation?: "auto" | "disabled";
  text?: {
    verbosity?: "low" | "medium" | "high";
  };
  top_logprobs?: number;
  [key: string]: unknown;
}

/**
 * OpenAI Responses API response
 */
export interface ResponsesAPIResponse {
  id: string;
  object: "response";
  output: ResponsesItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
