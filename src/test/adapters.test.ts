import * as assert from "assert";
import * as vscode from "vscode";
import { ChatCompletionsAdapter, ResponsesAdapter } from "../adapters";
import type { OpenAICustomModelConfig } from "../types";

suite("Adapters", () => {
  const mockConfig: OpenAICustomModelConfig = {
    id: "test-model",
    displayName: "Test Model",
    modelName: "test",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    family: "Test",
    tooltip: "Test model",
    maxInputTokens: 4096,
    maxOutputTokens: 2048,
    context_length: 4096,
    capabilities: {
      supports_tools: true,
      supports_image: false,
    },
  };

  suite("ChatCompletionsAdapter", () => {
    test("buildRequest generates correct endpoint", () => {
      const adapter = new ChatCompletionsAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const { endpoint, body } = adapter.buildRequest(messages, options, mockConfig);

      assert.ok(endpoint.endsWith("/chat/completions"));
      assert.equal(body.model, "test");
      assert.ok(body.stream);
    });

    test("buildRequest handles tools", () => {
      const adapter = new ChatCompletionsAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        modelOptions: {},
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const { body } = adapter.buildRequest(messages, options, mockConfig);

      assert.ok(Array.isArray(body.tools));
      assert.equal((body.tools as Array<Record<string, unknown>>).length, 1);
      assert.equal(body.tool_choice, "auto");
    });

    test("parseStreamEvent handles text delta", () => {
      const adapter = new ChatCompletionsAdapter();
      const line = 'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "text");
      if (result.type === "text") {
        assert.equal(result.content, "Hello");
      }
    });

    test("parseStreamEvent handles [DONE]", () => {
      const adapter = new ChatCompletionsAdapter();
      const line = "data: [DONE]";

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "done");
    });

    test("parseStreamEvent handles tool call delta", () => {
      const adapter = new ChatCompletionsAdapter();
      const line =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"test_tool","arguments":"{\\"q\\":"}}]},"index":0}]}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "tool_call");
      if (result.type === "tool_call") {
        assert.equal(result.index, 0);
        assert.equal(result.id, "call_123");
        assert.equal(result.name, "test_tool");
      }
    });
  });

  suite("ResponsesAdapter", () => {
    test("buildRequest generates correct endpoint", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const };
      const { endpoint, body } = adapter.buildRequest(messages, options, config);

      assert.ok(endpoint.endsWith("/responses"));
      assert.equal(body.model, "test");
      assert.ok(body.stream);
      assert.ok(Array.isArray(body.input));
    });

    test("buildRequest converts messages to items", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const };
      const { body } = adapter.buildRequest(messages, options, config);

      const items = body.input as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(items));
      assert.ok(items.length > 0);
      assert.equal(items[0].type, "message");
    });

    test("buildRequest includes instructions", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = {
        ...mockConfig,
        apiMode: "responses" as const,
        instructions: "You are a helpful assistant",
      };
      const { body } = adapter.buildRequest(messages, options, config);

      assert.equal(body.instructions, "You are a helpful assistant");
    });

    test("buildRequest includes reasoning effort", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = {
        ...mockConfig,
        apiMode: "responses" as const,
        reasoning: { effort: "medium" as const },
      };
      const { body } = adapter.buildRequest(messages, options, config);

      const reasoning = body.reasoning as Record<string, unknown>;
      assert.ok(reasoning);
      assert.equal(reasoning.effort, "medium");
    });

    test("parseStreamEvent handles output_text delta", () => {
      const adapter = new ResponsesAdapter();
      const line = 'data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "text");
      if (result.type === "text") {
        assert.equal(result.content, "Hello");
      }
    });

    test("parseStreamEvent handles response.done", () => {
      const adapter = new ResponsesAdapter();
      const line = 'data: {"type":"response.done"}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "done");
    });

    test("isUnsupportedError detects 404", () => {
      const adapter = new ResponsesAdapter();
      assert.ok(adapter.isUnsupportedError(404, "Not Found"));
    });

    test("isUnsupportedError detects unsupported messages", () => {
      const adapter = new ResponsesAdapter();
      assert.ok(adapter.isUnsupportedError(400, "Endpoint not supported"));
      assert.ok(adapter.isUnsupportedError(400, "Not implemented"));
    });
  });
});
