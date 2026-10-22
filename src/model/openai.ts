import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ChatTurnRequest, ChatTurnResponse, ModelClient, ModelRequest, ModelResponse } from './llm.js';

export const DEFAULT_OPENAI_MODEL_ID = 'gpt-5.5';

/**
 * OpenAI via the official SDK (Chat Completions). The harness speaks the Anthropic block shapes
 * (text, tool_use, tool_result); this client translates them to messages, tool calls and tool
 * results and back, so the loop and its tests stay provider-neutral.
 */
export class OpenAIModelClient implements ModelClient {
  private readonly client?: OpenAI;
  private readonly initError?: Error;
  readonly id: string;

  constructor(options: { modelId?: string; apiKey?: string; timeoutMs?: number; client?: OpenAI } = {}) {
    this.id = options.modelId ?? DEFAULT_OPENAI_MODEL_ID;
    // The SDK refuses to construct without credentials; keep that a readable call-time failure the stages record.
    try {
      this.client = options.client ?? new OpenAI({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeout: options.timeoutMs ?? 120_000, maxRetries: 2 });
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
    }
  }

  private api(): OpenAI {
    if (!this.client) throw this.initError ?? new Error('OpenAI client unavailable');
    return this.client;
  }

  /** Schema-constrained JSON output. The schema is validated again with zod after parsing. */
  async complete<T>(req: ModelRequest<T>): Promise<ModelResponse<T>> {
    const schema = jsonSchemaOf(req.schema);
    const response = await this.api().chat.completions.create({
      model: this.id,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema, strict: false } },
    });
    const choice = response.choices[0];
    const base = { model: response.model, inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0, stopReason: choice?.finish_reason ?? 'unknown' };
    if (!choice) return { ...base, parsed: null, error: 'no choices in the response' };
    if (choice.finish_reason === 'length') return { ...base, parsed: null, error: 'response truncated at max_tokens' };
    if (choice.finish_reason === 'content_filter' || choice.message.refusal) return { ...base, parsed: null, error: `model declined: ${choice.message.refusal ?? 'content filter'}` };
    let raw: unknown;
    try {
      raw = JSON.parse(choice.message.content ?? '');
    } catch {
      return { ...base, parsed: null, error: 'response was not JSON' };
    }
    const parsed = req.schema.safeParse(raw);
    return { ...base, parsed: parsed.success ? parsed.data : null, ...(parsed.success ? {} : { error: 'response did not match the schema' }) };
  }

  /**
   * One harness turn on the Responses API: strict function tools with reasoning on. Reasoning items come
   * back encrypted and ride along in the transcript as redacted thinking blocks, so later turns keep them.
   */
  async turn(req: ChatTurnRequest): Promise<ChatTurnResponse> {
    const response = await this.api().responses.create({
      model: this.id,
      instructions: req.system,
      input: toResponseInput(req.messages),
      tools: req.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description ?? '', parameters: t.input_schema as Record<string, unknown>, strict: true })),
      tool_choice: 'auto',
      max_output_tokens: req.maxTokens,
      reasoning: { effort: req.effort ?? 'medium' },
      include: ['reasoning.encrypted_content'],
      store: false,
    });
    // OpenAI counts cached tokens inside input_tokens; report them apart, as the Anthropic client does.
    const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const base = { model: response.model, inputTokens: Math.max(0, (response.usage?.input_tokens ?? 0) - cached), outputTokens: response.usage?.output_tokens ?? 0, cacheReadTokens: cached };
    const content: Anthropic.Beta.BetaContentBlock[] = [];
    let refusal: string | undefined;
    for (const item of response.output) {
      if (item.type === 'reasoning') content.push({ type: 'redacted_thinking', data: JSON.stringify(item) });
      else if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') content.push({ type: 'text', text: part.text, citations: null });
          else if (part.type === 'refusal') refusal = part.refusal;
        }
      } else if (item.type === 'function_call') {
        let input: unknown = {};
        try {
          input = JSON.parse(item.arguments || '{}');
        } catch {
          input = { __invalid_json: item.arguments };
        }
        content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
      }
    }
    if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') return { ...base, content, stopReason: 'max_tokens', error: 'response truncated at max_tokens' };
    if (refusal || response.incomplete_details?.reason === 'content_filter') return { ...base, content, stopReason: 'refusal', error: `model declined: ${refusal ?? 'content filter'}` };
    if (response.status === 'failed') return { ...base, content, stopReason: 'failed', error: `response failed: ${response.error?.message ?? 'unknown'}` };
    return { ...base, content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}

/** Anthropic-shaped transcript (text, tool_use, tool_result, redacted reasoning) to Responses API input items. */
export function toResponseInput(messages: Anthropic.Beta.BetaMessageParam[]): OpenAI.Responses.ResponseInputItem[] {
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') out.push({ role: m.role, content: block.text });
      else if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        out.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? `ERROR: ${text}` : text });
      } else if (block.type === 'tool_use') out.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      else if (block.type === 'redacted_thinking') {
        try {
          out.push(JSON.parse(block.data) as OpenAI.Responses.ResponseReasoningItem);
        } catch {
          // not a reasoning item of ours; skip
        }
      }
    }
  }
  return out;
}

/** JSON Schema for a zod type, without the meta key OpenAI rejects. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}

/** Anthropic-shaped transcript (text, tool_use, tool_result) to Chat Completions messages. */
export function toOpenAIMessages(messages: Anthropic.Beta.BetaMessageParam[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      const texts: string[] = [];
      for (const block of m.content) {
        if (block.type === 'text') texts.push(block.text);
        else if (block.type === 'tool_result') out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') });
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
      continue;
    }
    const texts: string[] = [];
    const calls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
    for (const block of m.content) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'tool_use') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
    out.push({ role: 'assistant', content: texts.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return out;
}
