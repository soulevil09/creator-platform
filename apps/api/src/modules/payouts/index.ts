// Public surface of the payouts module. Contract only at Session 05 — the
// Paxum adapter that implements it arrives in Session 06.
export type {
  IPayoutProvider,
  NormalizedPayoutEvent,
  PayoutItemResult,
  PayoutParams,
  PayoutRecipient,
  PayoutResult,
  PayoutStatus,
} from './provider.interface.js';
