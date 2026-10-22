import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { z } from 'zod';
import { OpenAIModelClient, toOpenAIMessages, toResponseInput, jsonSchemaOf } from '../src/model/openai.js';
import { resolveProvider, createModelClient, defaultModelId } from '../src/model/provider.js';
import { harnessTools } from '../src/model/agent.js';

/** A stub of the SDK that records the request and answers with a canned completion. */
function stub(answer: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const create = async (params: Record<string, unknown>) => (calls.push(params), answer);
  const client = { chat: { completions: { create } }, responses: { create } } as unknown as OpenAI;
  return { client, calls };
}
const usage = { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } };
const rusage = { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 60 };
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' };

describe('OpenAIModelClient', () => {
  it('runs a harness turn on the Responses API: strict function tools in, reasoning and tool calls out as blocks', async () => {
    const { client, calls } = stub({ model: 'gpt-5.5', status: 'completed', incomplete_details: null, usage: rusage, output: [reasoning, { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Looking at the catalog.', annotations: [] }] }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_evidence', arguments: '{"kind":"page","id":"https://shop.test/"}' }] });
    const model = new OpenAIModelClient({ client, modelId: 'gpt-5.5' });
    const tools = harnessTools(false);
    const response = await model.turn({
      system: 'rules',
      tools,
      maxTokens: 1000,
      effort: 'medium',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'evidence', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: JSON.stringify(reasoning) }, { type: 'tool_use', id: 'call_0', name: 'fetch_json', input: { url: 'https://shop.test/api' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'out of scope', is_error: true }] },
      ],
    });
    expect(response).toMatchObject({ stopReason: 'tool_use', model: 'gpt-5.5', inputTokens: 50, outputTokens: 10, cacheReadTokens: 20 });
    expect(response.content).toEqual([
      { type: 'redacted_thinking', data: JSON.stringify(reasoning) },
      { type: 'text', text: 'Looking at the catalog.', citations: null },
      { type: 'tool_use', id: 'call_1', name: 'get_evidence', input: { kind: 'page', id: 'https://shop.test/' } },
    ]);
    const req = calls[0]!;
    expect(req).toMatchObject({ model: 'gpt-5.5', instructions: 'rules', max_output_tokens: 1000, tool_choice: 'auto', reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'], store: false });
    const sent = req['tools'] as Array<{ type: string; name: string; strict: boolean; parameters: { additionalProperties: boolean } }>;
    expect(sent.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(sent.every((t) => t.type === 'function' && t.strict && t.parameters.additionalProperties === false)).toBe(true);
    expect(req['input']).toEqual([
      { role: 'user', content: 'evidence' },
      reasoning,
      { type: 'function_call', call_id: 'call_0', name: 'fetch_json', arguments: '{"url":"https://shop.test/api"}' },
      { type: 'function_call_output', call_id: 'call_0', output: 'ERROR: out of scope' },
    ]);
  });

  it('maps truncation and refusals to errors and a plain completion to end_turn', async () => {
    const stop = new OpenAIModelClient({ client: stub({ model: 'm', status: 'completed', incomplete_details: null, usage: rusage, output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }] }).client });
    expect(await stop.turn({ system: 's', tools: [], maxTokens: 10, messages: [{ role: 'user', content: 'x' }] })).toMatchObject({ stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
    const long = new OpenAIModelClient({ client: stub({ model: 'm', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: rusage, output: [] }).client });
    expect((await long.turn({ system: 's', tools: [], maxTokens: 10, messages: [{ role: 'user', content: 'x' }] })).error).toContain('max_tokens');
    const refused = new OpenAIModelClient({ client: stub({ model: 'm', status: 'completed', incomplete_details: null, usage: rusage, output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] }).client });
    expect((await refused.turn({ system: 's', tools: [], maxTokens: 10, messages: [{ role: 'user', content: 'x' }] })).error).toContain('declined');
    expect(toResponseInput([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('completes schema-constrained JSON and validates it with zod', async () => {
    const schema = z.object({ purpose: z.string(), confidence: z.number() });
    const { client, calls } = stub({ model: 'gpt-5.5', usage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"purpose":"a shop","confidence":0.8}' } }] });
    const model = new OpenAIModelClient({ client });
    const ok = await model.complete({ system: 's', user: 'u', schema, maxTokens: 500 });
    expect(ok.parsed).toEqual({ purpose: 'a shop', confidence: 0.8 });
    const fmt = calls[0]!['response_format'] as { type: string; json_schema: { schema: Record<string, unknown> } };
    expect(fmt.type).toBe('json_schema');
    expect(fmt.json_schema.schema['$schema']).toBeUndefined();
    expect((fmt.json_schema.schema['properties'] as Record<string, unknown>)['purpose']).toEqual({ type: 'string' });
    const bad = new OpenAIModelClient({ client: stub({ model: 'm', usage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"nope":1}' } }] }).client });
    expect((await bad.complete({ system: 's', user: 'u', schema, maxTokens: 500 })).error).toContain('schema');
    expect(jsonSchemaOf(schema)['required']).toEqual(['purpose', 'confidence']);
    expect(toOpenAIMessages([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('provider selection', () => {
  it('prefers an explicit provider, then the model id prefix, then the keys in the environment', () => {
    expect(resolveProvider({ provider: 'openai', modelId: 'claude-opus-5-5' }, {})).toBe('openai');
    expect(resolveProvider({ modelId: 'gpt-5.5' }, {})).toBe('openai');
    expect(resolveProvider({ modelId: 'o3' }, {})).toBe('openai');
    expect(resolveProvider({ modelId: 'claude-opus-5-5' }, { OPENAI_API_KEY: 'x' })).toBe('anthropic');
    expect(resolveProvider({}, { OPENAI_API_KEY: 'x' })).toBe('openai');
    expect(resolveProvider({}, { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toBe('anthropic');
    expect(resolveProvider({}, { WEBMORPH_MODEL_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'y' })).toBe('openai');
    expect(resolveProvider({}, {})).toBe('anthropic');
    expect(defaultModelId('openai')).toBe('gpt-5.5');
    expect(createModelClient({ provider: 'openai' }).id).toBe('gpt-5.5');
    expect(createModelClient({ modelId: 'claude-opus-5-5' }).id).toBe('claude-opus-5-5');
  });
});
