import { STATUS } from './protocol';
import { isTransportFailed, type TransferResult, type TransferStep } from './transfer';

/**
 * How a wired transfer ended, as one of four things rather than a bag of flags.
 *
 * `confirmed` and `rejected` are both about the firmware answering the commit:
 * `confirmed` means it answered `0x01`, which is the only answer that lets the
 * page move `applied`. `failed` means the transfer died before that point, so
 * nothing was staged. `busy` means the service lock was held and nothing was
 * attempted at all.
 *
 * The 2.4 GHz path has no reply, so it never produces a `confirmed` outcome: its
 * writes are recorded as sent, and the page says so in different words.
 */
export type SendOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'rejected'; readonly status: number | null }
  | { readonly kind: 'confirmed' };

/** The status of the last step with this name, or null when it never ran. */
function commitStatus(steps: readonly TransferStep[]): number | null {
  return steps.filter((step) => step.step === 'commit').at(-1)?.reply.status ?? null;
}

/**
 * Classifies a finished sequence. Transport failure wins over the commit: a
 * sequence whose begin was refused did not reach the firmware, whatever a later
 * step claims.
 */
export function classifySteps(steps: readonly TransferStep[]): SendOutcome {
  if (steps.length === 0) return { kind: 'failed' };
  if (isTransportFailed(steps)) return { kind: 'failed' };

  const status = commitStatus(steps);
  return status === STATUS.ok ? { kind: 'confirmed' } : { kind: 'rejected', status };
}

/** The same classification for a whole result, with the service lock folded in. */
export function classifyTransfer(result: TransferResult): SendOutcome {
  if (result.busy) return { kind: 'busy' };
  return classifySteps(result.steps);
}
