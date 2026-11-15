import { describe, expect, it } from 'vitest';
import { classifySteps, classifyTransfer } from './outcome';
import type { TransferReply, TransferStep } from './transfer';

const reply = (status: number | null): TransferReply => ({ status, raw: null, ms: 0 });

const begin = (status: number | null): TransferStep => ({ step: 'begin', reply: reply(status) });
const announce = (status: number | null): TransferStep => ({
  step: 'announce',
  reply: reply(status),
});
const commit = (status: number | null): TransferStep => ({ step: 'commit', reply: reply(status) });
const aborted = (): TransferStep => ({ step: 'aborted', reply: reply(null) });

// `TransferService` pushes a `chunks` step only when staging died, never on a
// successful sequence, so it belongs in the failure fixtures alone.
const chunks = (status: number | null): TransferStep => ({ step: 'chunks', reply: reply(status) });

/** What a completed sequence looks like: begin, announce, commit. */
const completed = (status: number | null): TransferStep[] => [
  begin(0x01),
  announce(0x01),
  commit(status),
];

describe('classifySteps', () => {
  it('confirms only when the commit answered 0x01', () => {
    expect(classifySteps(completed(0x01))).toEqual({ kind: 'confirmed' });
  });

  it('carries the firmware rejection status', () => {
    expect(classifySteps(completed(0xff))).toEqual({ kind: 'rejected', status: 0xff });
  });

  it('keeps a silent commit apart from a rejection', () => {
    expect(classifySteps(completed(null))).toEqual({ kind: 'rejected', status: null });
  });

  it('calls a refused begin a transport failure, whatever a later step says', () => {
    expect(classifySteps([begin(0xff), aborted(), commit(0x01)])).toEqual({ kind: 'failed' });
  });

  it('calls an aborted sequence a failure', () => {
    expect(classifySteps([begin(0x01), announce(0x01), aborted()])).toEqual({ kind: 'failed' });
  });

  it('calls staging that never landed a failure', () => {
    expect(classifySteps([begin(0x01), announce(0x01), chunks(null)])).toEqual({ kind: 'failed' });
  });

  it('treats an empty sequence as a failure, not a success', () => {
    expect(classifySteps([])).toEqual({ kind: 'failed' });
  });

  it('rejects a sequence whose commit never ran', () => {
    expect(classifySteps([begin(0x01), announce(0x01)])).toEqual({
      kind: 'rejected',
      status: null,
    });
  });
});

describe('classifyTransfer', () => {
  it('reports the service lock without looking at the steps', () => {
    expect(classifyTransfer({ steps: [], busy: true })).toEqual({ kind: 'busy' });
  });

  it('classifies the steps of a normal result', () => {
    expect(classifyTransfer({ steps: completed(0x01) })).toEqual({ kind: 'confirmed' });
    expect(classifyTransfer({ steps: [begin(0x01), announce(0x01), aborted()] })).toEqual({
      kind: 'failed',
    });
  });
});
