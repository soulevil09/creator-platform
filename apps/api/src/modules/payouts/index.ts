// Public surface of the payouts module.
export { createPayoutsService, PayoutError, type PayoutsService } from './payouts.service.js';
export {
  getPayoutProvider,
  assertPayoutProviderConfigured,
  resetPayoutProviderCache,
} from './provider.factory.js';
export { computeRevenueSplit, type RevenueSplit } from './revenue.js';
export {
  PayoutProviderConfigError,
  PayoutProviderError,
  type IPayoutProvider,
  type NormalizedPayoutEvent,
  type PayoutItemResult,
  type PayoutParams,
  type PayoutRecipient,
  type PayoutResult,
  type PayoutStatus,
} from './provider.interface.js';
export { PaxumAdapter } from './adapters/paxum.adapter.js';
export { MockPayoutProvider } from './adapters/mock.adapter.js';
export { default as payoutRoutes } from './payouts.routes.js';
