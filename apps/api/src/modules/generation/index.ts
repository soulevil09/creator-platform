// Public surface of the generation module.
export {
  createGenerationService,
  GenerationError,
  type GenerationService,
} from './generation.service.js';
export {
  getAIProvider,
  assertAIProviderConfigured,
  resetAIProviderCache,
} from './provider.factory.js';
export {
  AIProviderConfigError,
  AIProviderError,
  type AIProviderName,
  type GenerateImageParams,
  type GeneratedImage,
  type IAIProvider,
} from './provider.interface.js';
export { buildAnchorPrompt, type AnchorPrompt } from './anchor.js';
export { checkPromptSafety, hashPrompt, type PromptSafetyResult } from './safety.js';
export { ReplicateAdapter } from './adapters/replicate.adapter.js';
export { MockAIProvider } from './adapters/mock.adapter.js';
export { default as generationRoutes } from './generation.routes.js';
