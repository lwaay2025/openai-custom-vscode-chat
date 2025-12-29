# 🤗 OpenAI Custom Provider for GitHub Copilot Chat

An extension that integrates OpenAI-compatible inference providers into GitHub Copilot Chat, supporting both the traditional Chat Completions API and the new Responses API.

## Features

- ✅ **Dual API Support**: Works with both `/v1/chat/completions` and `/v1/responses` endpoints
- ✅ **Tool Calling**: Full support for Copilot tools and function calling
- ✅ **Streaming**: Real-time token-by-token response streaming
- ✅ **Reasoning Support**: Configure thinking level/reasoning effort for capable models
- ✅ **Auto Fallback**: Automatic fallback to Chat Completions if Responses API is unavailable
- ✅ **Multi-Provider**: Support multiple OpenAI-compatible services simultaneously

## Installation

1. Install the extension from the Visual Studio Marketplace
2. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
3. Run `Manage openai custom Provider`
4. Configure your model settings (see Configuration below)

## Configuration

### Model Configuration File

Create a JSON configuration file with your model settings. The extension supports both Chat Completions and Responses API modes.

#### Basic Configuration (Chat Completions)

```json
{
  "models": [
    {
      "id": "my-model",
      "displayName": "My Model",
      "modelName": "gpt-4",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "family": "OpenAI",
      "tooltip": "GPT-4 model via Chat Completions API",
      "maxInputTokens": 128000,
      "maxOutputTokens": 4096,
      "capabilities": {
        "supports_tools": true,
        "supports_image": false
      },
      "isDefault": false,
      "apiMode": "chat_completions"
    }
  ]
}
```

#### Advanced Configuration (Responses API)

```json
{
  "models": [
    {
      "id": "advanced-model",
      "displayName": "Advanced Model",
      "modelName": "gpt-5",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "family": "OpenAI",
      "tooltip": "GPT-5 with Responses API support",
      "maxInputTokens": 128000,
      "maxOutputTokens": 4096,
      "capabilities": {
        "supports_tools": true,
        "supports_image": false
      },
      "isDefault": false,
      "apiMode": "responses",
      "instructions": "You are a helpful Copilot assistant specialized in code generation.",
      "reasoning": {
        "effort": "medium",
        "summary": "auto"
      },
      "truncation": "auto",
      "text": {
        "verbosity": "medium"
      },
      "toolChoice": "auto",
      "parallelToolCalls": true,
      "fallbackToChatCompletions": true
    }
  ]
}
```

### Configuration Fields

#### Required Fields

- `id`: Unique identifier for the model
- `displayName`: Display name shown in VS Code
- `modelName`: Model name sent to the API
- `baseUrl`: Base URL of the API (e.g., `https://api.openai.com/v1`)
- `apiKey`: Your API key
- `family`: Model family name
- `maxInputTokens`: Maximum input token limit
- `maxOutputTokens`: Maximum output token limit
- `capabilities`: Object with `supports_tools` and `supports_image` booleans

#### Optional Fields

- `tooltip`: Description shown on hover
- `isDefault`: Whether this is the default model (boolean)
- `apiMode`: API mode - `"chat_completions"` (default) or `"responses"`

#### Responses API Specific Fields

When using `apiMode: "responses"`, you can also configure:

- `instructions`: System instructions/prompt for the model
- `reasoning`: Object with `effort` (`"low"`, `"medium"`, or `"high"`) and optional `summary` (`"auto"` or `"none"`)
- `truncation`: Truncation mode (`"auto"` or `"disabled"`)
- `text`: Text configuration object (supports `verbosity`: `"low"`, `"medium"`, or `"high"`)
- `toolChoice`: Tool calling mode - `"auto"`, `"none"`, or `"required"`
- `parallelToolCalls`: Enable parallel tool execution (boolean)
- `fallbackToChatCompletions`: Auto-fallback if Responses API is unavailable (boolean)
- `supportsSystemRole`: Whether the model supports the `system` role. If `false`, system messages are converted to user messages with a `[System]: ` prefix. (boolean, default: `true`)
- `proxy`: Proxy server URL (e.g., `http://127.0.0.1:8888` for Fiddler). (string, default: none)

## API Mode Comparison

### Chat Completions API (`/v1/chat/completions`)

- Traditional OpenAI API format
- Widely supported by most providers
- Uses messages array format
- Best for basic chat interactions

### Responses API (`/v1/responses`)

- Modern OpenAI API with Items-based format
- Supports advanced features:
  - Explicit reasoning/thinking configuration
  - Better structured tool calling
  - More granular control over model behavior
- Auto-falls back to Chat Completions if not supported

## Fallback Behavior

When `fallbackToChatCompletions: true` is set and the Responses API returns:
- HTTP 404 (Not Found)
- HTTP 405 (Method Not Allowed)
- HTTP 501 (Not Implemented)
- Error messages containing "not supported" or "not implemented"

The extension will automatically retry the request using the Chat Completions API and show a one-time warning message.

## Tool Calling

Both API modes support Copilot's tool calling features:

1. VS Code tools are automatically converted to OpenAI function tool format
2. Model can trigger tool calls during conversation
3. VS Code executes the tools and returns results
4. Model continues generation with tool results

Tool modes:
- `auto`: Model decides when to use tools (default)
- `none`: Tools are disabled
- `required`: Model must use a tool (single tool only)

## Examples

### Multiple Providers

```json
{
  "models": [
    {
      "id": "openai-gpt4",
      "displayName": "OpenAI GPT-4",
      "modelName": "gpt-4",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "apiMode": "chat_completions",
      ...
    },
    {
      "id": "azure-gpt4",
      "displayName": "Azure GPT-4",
      "modelName": "gpt-4",
      "baseUrl": "https://your-resource.openai.azure.com/v1",
      "apiKey": "...",
      "apiMode": "responses",
      "fallbackToChatCompletions": true,
      ...
    },
    {
      "id": "local-llama",
      "displayName": "Local Llama",
      "modelName": "llama-3-70b",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "not-needed",
      "apiMode": "chat_completions",
      ...
    }
  ]
}
```

## Troubleshooting

### Responses API Not Working

If you're getting errors with `apiMode: "responses"`:

1. Verify your provider supports the Responses API
2. Enable fallback: `"fallbackToChatCompletions": true`
3. Check the extension logs in VS Code Output panel (OpenAI Custom)

### Token Limit Errors

Adjust `maxInputTokens` and `maxOutputTokens` to match your model's capabilities.

### Tools Not Working

1. Ensure `capabilities.supports_tools` is `true`
2. Check that your model actually supports function calling
3. Try setting `toolChoice: "auto"` explicitly

## Development

### Building

```bash
npm install
npm run compile
```

### Testing

```bash
npm test
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.

