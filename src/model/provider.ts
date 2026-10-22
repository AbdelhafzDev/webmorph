import { AnthropicModelClient, DEFAULT_MODEL_ID, type ModelClient } from './llm.js';
import { OpenAIModelClient, DEFAULT_OPENAI_MODEL_ID } from './openai.js';

export type ModelProvider = 'anthropic' | 'openai';

export interface ModelClientOptions {
  provider?: ModelProvider;
  modelId?: string;
}

/** Provider from an explicit choice, else the model id's prefix, else whichever key the environment holds. */
export function resolveProvider(options: ModelClientOptions, env: NodeJS.ProcessEnv = process.env): ModelProvider {
  if (options.provider) return options.provider;
  const id = options.modelId?.toLowerCase() ?? '';
  if (/^(gpt-|o[0-9]|chatgpt-)/.test(id)) return 'openai';
  if (/^claude-/.test(id)) return 'anthropic';
  const fromEnv = env['WEBMORPH_MODEL_PROVIDER']?.toLowerCase();
  if (fromEnv === 'openai' || fromEnv === 'anthropic') return fromEnv;
  if (env['OPENAI_API_KEY'] && !env['ANTHROPIC_API_KEY'] && !env['ANTHROPIC_AUTH_TOKEN']) return 'openai';
  return 'anthropic';
}

export function defaultModelId(provider: ModelProvider): string {
  return provider === 'openai' ? DEFAULT_OPENAI_MODEL_ID : DEFAULT_MODEL_ID;
}

/** The model client every model-using stage constructs when none is injected. */
export function createModelClient(options: ModelClientOptions = {}): ModelClient {
  const provider = resolveProvider(options);
  const modelId = options.modelId ?? defaultModelId(provider);
  return provider === 'openai' ? new OpenAIModelClient({ modelId }) : new AnthropicModelClient({ modelId });
}
