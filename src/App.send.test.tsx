import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WebHid, WebHidDevice } from '@/lib/hid';
import { App } from './App';

const reply = (cmd: number, status: number) => {
  const bytes = new Uint8Array(64);
  bytes[0] = 0x04;
  bytes[1] = cmd;
  bytes[3] = status;
  return bytes;
};

type BoardOptions = {
  /** Status the board answers the begin command with. */
  readonly begin?: number;
  /** Commit statuses, taken one per upload. */
  readonly commits?: number[];
};

/** A board that answers every step the service waits on. */
const makeBoard = ({ begin = 0x01, commits = [0x01] }: BoardOptions = {}) => {
  const queue: Uint8Array[] = [];

  const device: WebHidDevice = {
    opened: false,
    productName: 'AK820',
    vendorId: 0x0c45,
    productId: 0x8009,
    collections: [{ usagePage: 0xff13, usage: 0x0001 }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_reportId, data) => {
      const bytes = new Uint8Array(data as Uint8Array);
      if (bytes[0] !== 0x04) return;

      if (bytes[1] === 0x18) queue.push(reply(0x18, begin));
      else if (bytes[1] === 0x11 || bytes[1] === 0x27) queue.push(reply(bytes[1], 0x01));
      else if (bytes[1] === 0x02) queue.push(reply(0x02, commits.shift() ?? 0x01));
      else if (bytes[1] === 0xf0) queue.push(reply(0xf0, 0x01));
    },
    receiveFeatureReport: async () => {
      const bytes = queue.shift() ?? new Uint8Array(64);
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const hid: WebHid = { requestDevice: async () => [device], getDevices: async () => [] };
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
  return device;
};

/** Connects, then maps CapsLock to media Mute, leaving one change pending. */
const connectAndChangeAKey = async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole('button', { name: /connect keyboard/i }));
  await screen.findByText('AK820');

  const board = screen.getByRole('group', { name: /keyboard board/i });
  await user.click(within(board).getByRole('button', { name: 'CapsLock' }));
  await user.click(screen.getByLabelText('Sends'));
  await user.type(screen.getByLabelText('Search a key or usage'), 'mute');
  await user.click(await screen.findByRole('option', { name: 'Media: Mute (c:0xE2)' }));

  return user;
};

const openLog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^log$/i }));
  return screen.getByRole('log');
};

describe('App send contract', () => {
  it('leaves the change pending when the firmware rejects the commit', async () => {
    makeBoard({ commits: [0xff] });
    const user = await connectAndChangeAKey();

    await user.click(screen.getByRole('button', { name: /upload 1 change/i }));
    await screen.findByText(/Nothing was applied/i, {}, { timeout: 8000 });

    // `applied` must not move: the key is still waiting for a real upload, and
    // the lock has to release before the button offers the same upload again.
    expect(
      await screen.findByRole('button', { name: /upload 1 change/i }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(await openLog(user)).toHaveTextContent(/Upload rejected \(0xFF\)/);
  }, 20000);

  it('leaves the change pending when the board refuses the transfer before staging', async () => {
    makeBoard({ begin: 0xff });
    const user = await connectAndChangeAKey();

    await user.click(screen.getByRole('button', { name: /upload 1 change/i }));
    await screen.findByText(/refused the transfer/i, {}, { timeout: 8000 });

    expect(
      await screen.findByRole('button', { name: /upload 1 change/i }, { timeout: 8000 }),
    ).toBeInTheDocument();
  }, 20000);

  it('releases the lock after a rejection, so the next upload goes out', async () => {
    makeBoard({ commits: [0xff, 0x01] });
    const user = await connectAndChangeAKey();

    await user.click(screen.getByRole('button', { name: /upload 1 change/i }));
    await screen.findByText(/Nothing was applied/i, {}, { timeout: 8000 });

    // A second press must reach the board, not be swallowed by a stuck lock.
    await user.click(
      await screen.findByRole('button', { name: /upload 1 change/i }, { timeout: 8000 }),
    );
    await screen.findByText('No pending changes', {}, { timeout: 8000 });

    expect(await openLog(user)).toHaveTextContent(/Upload accepted/);
  }, 20000);
});
