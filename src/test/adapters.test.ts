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

      const items = body.input as Array<Record<string, unknown>>;
      assert.equal(items[0].role, "system");
      const content = items[0].content as Array<Record<string, unknown>>;
      assert.equal(content[0].text, "You are a helpful assistant");
      assert.strictEqual((body as Record<string, unknown>).instructions, undefined);
    });

    test("buildRequest uses previous_response_id from stateful_marker and slices history", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("OLD")],
          name: undefined,
        },
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          // LanguageModelDataPart is not yet included in the
          // assistant message content union for the current
          // @types/vscode version, so cast to relax typing.
          content: [vscode.LanguageModelDataPart.text("test-model\\resp_123", "stateful_marker") as unknown as vscode.LanguageModelTextPart],
          name: undefined,
        },
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("NEW")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const };
      const { body } = adapter.buildRequest(messages, options, config);

      assert.equal((body as Record<string, unknown>).previous_response_id, "resp_123");

      const items = body.input as Array<Record<string, unknown>>;
      const allText = JSON.stringify(items);
      assert.ok(!allText.includes("OLD"), "expected sliced history to exclude OLD");
      assert.ok(allText.includes("NEW"), "expected sliced history to include NEW");
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

    test("buildRequest includes truncation/text verbosity/reasoning summary/top_logprobs", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: { logprobs: true },
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = {
        ...mockConfig,
        apiMode: "responses" as const,
        truncation: "auto" as const,
        text: { verbosity: "medium" as const },
        reasoning: { effort: "low" as const, summary: "auto" as const },
      };
      const { body } = adapter.buildRequest(messages, options, config);

      assert.equal((body as Record<string, unknown>).top_logprobs, 3);
      assert.equal((body as Record<string, unknown>).truncation, "auto");
      assert.deepEqual((body as Record<string, unknown>).text, { verbosity: "medium" });
      const reasoning = (body as Record<string, unknown>).reasoning as Record<string, unknown>;
      assert.equal(reasoning.effort, "low");
      assert.equal(reasoning.summary, "auto");
    });

    test("buildRequest converts image parts to input_image", () => {
      const adapter = new ResponsesAdapter();
      // LanguageModelDataPart is ahead of the current typings for
      // chat message content, so cast to keep tests compiling.
      const img = vscode.LanguageModelDataPart.image(
        new Uint8Array([1, 2, 3, 4]),
        "image/png"
      ) as unknown as vscode.LanguageModelTextPart;
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("What is this?"), img],
          name: undefined,
        },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const };
      const { body } = adapter.buildRequest(messages, options, config);
      const items = (body as Record<string, unknown>).input as Array<Record<string, unknown>>;
      const msg = items.find((it) => it.type === "message") as Record<string, unknown> | undefined;
      assert.ok(msg);
      const content = msg?.content as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(content));
      assert.ok(content.some((c) => c.type === "input_image" && typeof c.image_url === "string"));
      const firstImg = content.find((c) => c.type === "input_image") as Record<string, unknown> | undefined;
      assert.ok(typeof firstImg?.image_url === "string" && (firstImg.image_url as string).startsWith("data:image/png;base64,"));
    });

    test("buildRequest applies tool output image hack (function_call_output text + user input_image message)", () => {
      const adapter = new ResponsesAdapter();
      const toolCall = new vscode.LanguageModelToolCallPart("call_img", "toolA", { q: 1 });
      const toolResult = new vscode.LanguageModelToolResultPart("call_img", [
        new vscode.LanguageModelTextPart("result"),
        // Relax type here to accommodate LanguageModelDataPart
        // until the tool result content union is updated upstream.
        vscode.LanguageModelDataPart.image(new Uint8Array([9, 8, 7]), "image/jpeg") as unknown as vscode.LanguageModelTextPart,
      ]);
      const messages: vscode.LanguageModelChatMessage[] = [
        { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
        { role: vscode.LanguageModelChatMessageRole.User, content: [toolResult], name: undefined },
      ];
      const options = {
        modelOptions: {},
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const };
      const { body } = adapter.buildRequest(messages, options, config);
      const items = (body as Record<string, unknown>).input as Array<Record<string, unknown>>;
      assert.ok(items.some((it) => it.type === "function_call_output"));
      assert.ok(items.some((it) => it.type === "message" && it.role === "user"));
      const hackMsg = items.find((it) => it.type === "message" && it.role === "user") as Record<string, unknown> | undefined;
      assert.ok(hackMsg);
      const content = hackMsg?.content as Array<Record<string, unknown>>;
      assert.ok(content.some((c) => c.type === "input_image"));
    });

    test("buildRequest maps toolChoice=required to Responses tool_choice='required' with multiple tools", () => {
      const adapter = new ResponsesAdapter();
      const messages: vscode.LanguageModelChatMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Hello")],
          name: undefined,
        },
      ];
      const options = {
        tools: [
          { name: "tool_a", description: "A", inputSchema: {} },
          { name: "tool_b", description: "B", inputSchema: {} },
        ],
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        modelOptions: {},
      } as vscode.ProvideLanguageModelChatResponseOptions;

      const config = { ...mockConfig, apiMode: "responses" as const, toolChoice: "required" as const };
      const { body } = adapter.buildRequest(messages, options, config);
      assert.equal((body as Record<string, unknown>).tool_choice, "required");
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

    test("parseStreamEvent assigns tool call indices by call_id", () => {
      const adapter = new ResponsesAdapter();

      const r1 = adapter.parseStreamEvent(
        'data: {"type":"response.function_call.delta","delta":{"call_id":"call_a","name":"tool_a","arguments":"{}"}}'
      );
      const r2 = adapter.parseStreamEvent(
        'data: {"type":"response.function_call_arguments.delta","delta":{"call_id":"call_a","delta":"{}"}}'
      );
      const r3 = adapter.parseStreamEvent(
        'data: {"type":"response.function_call.delta","delta":{"call_id":"call_b","name":"tool_b","arguments":"{}"}}'
      );

      assert.equal(r1.type, "tool_call");
      assert.equal(r2.type, "tool_call");
      assert.equal(r3.type, "tool_call");

      if (r1.type === "tool_call" && r2.type === "tool_call" && r3.type === "tool_call") {
        assert.equal(r1.index, 0);
        assert.equal(r2.index, 0);
        assert.equal(r3.index, 1);
        assert.equal(r1.id, "call_a");
        assert.equal(r3.id, "call_b");
      }
    });

    test("parseStreamEvent handles output_item function_call", () => {
      const adapter = new ResponsesAdapter();
      const line =
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_123","name":"test_tool","arguments":"{}"}}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "tool_call");
      if (result.type === "tool_call") {
        assert.equal(result.index, 0);
        assert.equal(result.id, "call_123");
        assert.equal(result.name, "test_tool");
        assert.equal(result.args, "{}");
      }
    });

    test("parseStreamEvent handles response.done", () => {
      const adapter = new ResponsesAdapter();
      const line = 'data: {"type":"response.done"}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "done");
    });

    test("parseStreamEvent handles response.completed as stateful_marker", () => {
      const adapter = new ResponsesAdapter();
      const line = 'data: {"type":"response.completed","response":{"id":"resp_123"}}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "stateful_marker");
      if (result.type === "stateful_marker") {
        assert.equal(result.marker, "resp_123");
      }
    });

    test("parseStreamEvent maps reasoning_summary delta to thinking", () => {
      const adapter = new ResponsesAdapter();
      const line = 'data: {"type":"response.reasoning_summary.delta","delta":{"text":"thinking..."}}';

      const result = adapter.parseStreamEvent(line);

      assert.equal(result.type, "thinking");
      if (result.type === "thinking") {
        assert.equal(result.text, "thinking...");
      }
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
