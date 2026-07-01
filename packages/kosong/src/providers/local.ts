import { type Message, type StreamedMessagePart, type ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  TOOL_RESULT_MEDIA_PROMPT,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  type ToolMessageConversion,
  toolToOpenAI,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
} from './openai-common';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';
import { LlamaServerProcess } from '../local/llama-server-process';

// ---- Constants -----------------------------------------------------------

const LOCAL_API_BASE = '/v1/chat/completions';
const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const;
const LLAMA_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id: string) => sanitizeToolCallId(id, 64),
};

// ---- Options --------------------------------------------------------------

/**
 * Configuration options for a local GGUF model served via llama-server.
 */
export interface LocalOptions {
  /** Absolute path to the .gguf model file. */
  modelPath: string;
  /** API key for the local server, if it requires one. */
  apiKey?: string;
  /** Base URL for the local llama-server (default http://127.0.0.1:18080). */
  baseUrl?: string;
  /** Context window size in tokens (default 131072). */
  contextSize?: number;
  /** Number of GPU layers to offload (0 = CPU-only, default 0). */
  gpuLayers?: number;
  /** Server listen port (default 18080). */
  port?: number;
  /** Model identifier passed to the Chat Completions API. */
  model: string;
  /**
   * Optional log callback to forward server logs to the TUI.
   * Messages are prefixed with `[llama-server]`.
   */
  onLog?: (message: string) => void;
  /**
   * Optional progress callback fired at each startup phase.
   * Use this to drive a spinner / status line in the TUI.
   */
  onStep?: (step: string) => void;
}

// ---- Internal OpenAI message helpers -------------------------------------
// (Adapted from openai-legacy.ts to keep local.ts fully self-contained.)

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    type: string;
    id: string;
    function: { name: string; arguments: string | null };
  }>;
  tool_call_id?: string;
  name?: string;
}

function isMediaPart(part: { type: string }): boolean {
  return part.type !== 'text' && part.type !== 'think';
}

function extractReasoningContent(
  source: unknown,
  explicitKey: string | undefined,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys = explicitKey !== undefined ? [explicitKey] : [...KNOWN_REASONING_KEYS];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function appendToolResultMediaMessage(
  messages: OpenAIMessage[],
  pendingToolResultMedia: OpenAIContentPart[],
): void {
  if (pendingToolResultMedia.length === 0) return;
  messages.push({
    role: 'user',
    content: [{ type: 'text' as const, text: TOOL_RESULT_MEDIA_PROMPT }, ...pendingToolResultMedia],
  });
  pendingToolResultMedia.length = 0;
}

function toolResultImageParts(message: Message): OpenAIContentPart[] {
  const images: OpenAIContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== 'image_url') continue;
    const converted = convertContentPart(part);
    if (converted !== null) {
      images.push(converted);
    }
  }
  return images;
}

function convertToolMessageContentForChat(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  const content = convertToolMessageContent(message, conversion);
  if (typeof content !== 'string') {
    return content;
  }
  const lines = content.length > 0 ? [content] : [];
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

function convertMessage(
  message: Message,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage {
  const nonThinkParts = message.content.filter((p): p is (typeof message.content)[number] => p.type !== 'think');

  const result: OpenAIMessage = { role: message.role };

  if (message.role === 'tool') {
    const hasNonTextPart = message.content.some((p) => isMediaPart(p));
    const effectiveConversion = hasNonTextPart ? 'extract_text' : toolMessageConversion;
    if (effectiveConversion !== null) {
      result.content = convertToolMessageContentForChat(message, effectiveConversion);
    } else {
      const firstPart = nonThinkParts[0];
      if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
        result.content = firstPart.text;
      } else if (nonThinkParts.length > 0) {
        result.content = nonThinkParts
          .map((p) => convertContentPart(p))
          .filter((p): p is OpenAIContentPart => p !== null);
      }
    }
  } else {
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      result.content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      result.content = nonThinkParts
        .map((p) => convertContentPart(p))
        .filter((p): p is OpenAIContentPart => p !== null);
    }
  }

  // Tool calls
  if (message.role === 'assistant' && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => ({
      type: 'function' as const,
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments ?? '' },
    }));
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  return result;
}

function convertHistoryMessages(
  history: readonly Message[],
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const pendingToolResultMedia: OpenAIContentPart[] = [];

  for (const msg of history) {
    if (msg.role !== 'tool') {
      appendToolResultMediaMessage(messages, pendingToolResultMedia);
    }
    messages.push(convertMessage(msg, toolMessageConversion));
    if (msg.role === 'tool') {
      pendingToolResultMedia.push(...toolResultImageParts(msg));
    }
  }

  appendToolResultMediaMessage(messages, pendingToolResultMedia);
  return messages;
}

// ---- SSE line reader -----------------------------------------------------

async function* readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        yield line;
      }
    }
  } finally {
    // Yield any remaining data in the buffer
    if (buffer.length > 0) {
      yield buffer;
    }
  }
}

function parseSSEData(line: string): unknown | null {
  // SSE format: "data: <json>"
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ---- StreamedMessage implementation --------------------------------------

class LocalStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: Response,
    isStream: boolean,
    reasoningKey: string | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response, reasoningKey);
    } else {
      this._iter = this._convertNonStreamResponse(response, reasoningKey);
    }
  }

  get id(): string | null { return this._id; }
  get usage(): TokenUsage | null { return this._usage; }
  get finishReason(): FinishReason | null { return this._finishReason; }
  get rawFinishReason(): string | null { return this._rawFinishReason; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private async *_convertNonStreamResponse(
    response: Response,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // Error-only response
    if (!response.ok) {
      throw convertOpenAIError({
        status: response.status,
        statusText: response.statusText,
        body: { error: body['error'] ?? body },
      });
    }

    this._id = String(body['id'] ?? '');
    const usage = body['usage'];
    if (usage) {
      this._usage = extractUsage(usage) ?? null;
    }

    const choices = body['choices'] as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return;

    this._captureFinishReason(String(choice['finish_reason'] ?? null));

    const message = choice['message'] as Record<string, unknown> | undefined;
    if (!message) return;

    const reasoning = extractReasoningContent(message, reasoningKey);
    if (reasoning) {
      yield { type: 'think', think: reasoning };
    }

    const content = message['content'];
    if (typeof content === 'string' && content.length > 0) {
      yield { type: 'text', text: content };
    }

    const toolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (tc['type'] !== 'function') continue;
        yield {
          type: 'function',
          id: String(tc['id'] ?? crypto.randomUUID()),
          name: String((tc['function'] as Record<string, unknown>)?.['name'] ?? ''),
          arguments: String((tc['function'] as Record<string, unknown>)?.['arguments'] ?? null) || null,
        } satisfies ToolCall;
      }
    }
  }

  private async *_convertStreamResponse(
    response: Response,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    if (!response.body) {
      // Non-streaming fallback: read the body as JSON in one shot
      yield* this._convertNonStreamResponse(response, reasoningKey);
      return;
    }

    if (!response.ok) {
      // Read the entire error body before throwing
      const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw convertOpenAIError({
        status: response.status,
        statusText: response.statusText,
        body: { error: errorBody['error'] ?? errorBody },
      });
    }

    const bufferedToolCalls = new Map<number | string, BufferedChatCompletionToolCall>();
    const reader = response.body.getReader();

    try {
      for await (const line of readLines(reader)) {
        const parsed = parseSSEData(line);
        if (parsed === null) continue;

        const chunk = parsed as Record<string, unknown>;
        if (chunk['id']) {
          this._id = String(chunk['id']);
        }

        const usage = chunk['usage'];
        if (usage) {
          this._usage = extractUsage(usage) ?? null;
        }

        const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) continue;

        const choice = choices[0];
        if (!choice) continue;

        // Capture finish_reason whenever present
        const finishReason = choice['finish_reason'];
        if (finishReason !== null && finishReason !== undefined) {
          this._captureFinishReason(String(finishReason));
        }

        const delta = choice['delta'] as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Reasoning content
        const reasoning = extractReasoningContent(delta, reasoningKey);
        if (reasoning) {
          yield { type: 'think', think: reasoning };
        }

        // Text content
        const content = delta['content'];
        if (typeof content === 'string' && content.length > 0) {
          yield { type: 'text', text: content };
        }

        // Tool calls
        const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const parts = convertChatCompletionStreamToolCall(
              tc as Parameters<typeof convertChatCompletionStreamToolCall>[0],
              bufferedToolCalls,
            );
            for (const part of parts) {
              yield part;
            }
          }
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    } finally {
      reader.releaseLock();
    }
  }
}

// ---- Public provider class -----------------------------------------------

/**
 * Chat provider backed by a local llama-server process serving an OpenAI-compatible API.
 *
 * ### Lifecycle
 * - The underlying {@link LlamaServerProcess} is lazily started on the first
 *   `generate()` call.
 * - The server stays alive across multiple `generate()` calls (hot).
 * - Callers should explicitly stop the server via `LlamaServerProcess.getInstance().stop()`
 *   when the provider is no longer needed.
 *
 * ### Wire format
 * - POSTs to `{baseUrl}/v1/chat/completions` using the OpenAI Chat Completions format.
 * - Reuses shared utilities from {@link openai-common} for finish-reason normalization,
 *   usage extraction, and error conversion.
 * - Parses the SSE stream natively (no OpenAI SDK dependency).
 */
export class LocalChatProvider implements ChatProvider {
  readonly name = 'local';
  readonly modelName: string;
  readonly baseUrl: string;

  private _reasoningEffort: string | undefined;
  private _thinkingEnabled = false;
  private _generationKwargs: Record<string, unknown> = {};
  private _defaultHeaders: Record<string, string> | undefined;
  private _reasoningKey: string | undefined;
  private _toolMessageConversion: ToolMessageConversion = null;

  constructor(private readonly options: LocalOptions) {
    const port = options.port ?? 18080;
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`;
    this.modelName = options.model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._reasoningEffort);
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // 1. Ensure the server is running
    const port = this.options.port ?? 18080;
    const server = LlamaServerProcess.getInstance(port);
    if (!server.running) {
      try {
        await server.start({
          modelPath: this.options.modelPath,
          port,
          contextSize: this.options.contextSize,
          gpuLayers: this.options.gpuLayers,
          onLog: this.options.onLog,
          onStep: this.options.onStep,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to start local model "${this.modelName}":\n${msg}\n` +
            'Run /enable_local again or check that llama-server.exe is available.',
        );
      }
    }

    // 2. Build message array
    const messages = this._buildMessages(systemPrompt, history);

    // 3. Build request params
    const kwargs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this._generationKwargs)) {
      if (value !== undefined) kwargs[key] = value;
    }

    if (this._reasoningEffort !== undefined) {
      kwargs['reasoning_effort'] = this._reasoningEffort;
    }

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: true,
      ...kwargs,
    };

    if (tools.length > 0) {
      body['tools'] = tools.map((t) => toolToOpenAI(t));
      body['stream_options'] = { include_usage: true };
    }

    // 4. Fire the request
    try {
      const url = `${this.baseUrl}${LOCAL_API_BASE}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this._defaultHeaders,
      };

      if (this.options.apiKey) {
        headers['Authorization'] = `Bearer ${this.options.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      return new LocalStreamedMessage(response, true, this._reasoningKey);
    } catch (error: unknown) {
      // Wrap network-level failures with model context
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error(
          `Network error while connecting to local model "${this.modelName}" at ${this.baseUrl}.\n` +
            'Ensure llama-server is running and the port is correct.',
        );
      }
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): LocalChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._reasoningEffort = reasoningEffort;
    clone._thinkingEnabled = effort !== 'off';
    return clone;
  }

  withMaxCompletionTokens(
    maxCompletionTokens: number,
    _options?: { usedContextTokens?: number; maxContextTokens?: number },
  ): LocalChatProvider {
    const clone = this._clone();
    clone._generationKwargs = {
      ...clone._generationKwargs,
      max_tokens: maxCompletionTokens,
    };
    return clone;
  }

  // ---- Internal helpers --------------------------------------------------

  private _buildMessages(systemPrompt: string, history: readonly Message[]): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    const thinkingDirective = this._thinkingEnabled ? '/think' : '/no_think';
    const systemContent = systemPrompt.length > 0
      ? `${systemPrompt}\n${thinkingDirective}`
      : thinkingDirective;
    if (systemContent.length > 0) {
      messages.push({ role: 'system', content: systemContent });
    }

    const normalizedHistory = normalizeToolCallIdsForProvider(
      history as Message[],
      LLAMA_CHAT_TOOL_CALL_ID_POLICY,
    );

    messages.push(...convertHistoryMessages(normalizedHistory, this._toolMessageConversion));
    return messages;
  }

  private _clone(): LocalChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)) as LocalChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
