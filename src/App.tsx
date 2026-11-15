import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { UpdateNotice } from '@/components/update-notice';
import { PageFooter } from '@/components/page-footer';
import { AppHeader } from '@/features/device/AppHeader';
import { ViewTabs, type View } from '@/features/device/ViewTabs';
import { updateSettings, useSettings } from '@/features/settings/useSettings';
import { useDevice, type ConnectOptions } from '@/features/device/useDevice';
import { KeyInspector } from '@/features/editor/KeyInspector';
import { KeymapBoard } from '@/features/editor/KeymapBoard';
import { LayerTabs } from '@/features/editor/LayerTabs';
import { PendingBar } from '@/features/editor/PendingBar';
import { WriteRules } from '@/features/editor/WriteRules';
import { LogDrawer } from '@/features/log/LogDrawer';
import { useLog } from '@/features/log/useLog';
import type { LightingStatus, LightingValues } from '@/features/lighting/LightingPanel';
import type { PerKeyStatus } from '@/features/lighting/PerKeyPanel';
import type { DeviceStatus } from '@/features/device/DevicePanel';
import type { ScreenStatus } from '@/features/screen/AnimationCard';
import type { TimeStatus } from '@/features/screen/ClockCard';
import { realClock } from '@/lib/clock';
import {
  createInitialState,
  editorReducer,
  getActiveRows,
  getPendingRows,
  getSelectedRow,
  loadLayers,
  pendingKeyPatches,
  saveLayers,
  validateUsage,
  type EditorRow,
  type EditorState,
  type FnOverride,
  type Layer,
  type StorageLike,
} from '@/lib/editor';
import { hex } from '@/lib/format';
import {
  HidClient,
  TransferService,
  classifySteps,
  classifyTransfer,
  formatClock,
} from '@/lib/hid';
import { buildTimePacket } from '@/lib/hid/time';
import { WirelessClient } from '@/lib/hid/wireless';
import { useBusyLock } from '@/features/send/useBusyLock';
import { FN_LOCKED, buildTable } from '@/lib/keymap';
import {
  buildLightRecord,
  buildPerKeyTable,
  buildPerKeyTrigger,
  describeLight,
  describePerKey,
} from '@/lib/lighting';
import { buildAnimationPayload } from '@/lib/screen';
import { buildSettingsRecord, describeSettings, type DeviceSettings } from '@/lib/device';
import { downloadText, profileFileName } from '@/lib/download';
import { buildProfile, type ParsedProfile } from '@/lib/profile';
import type { PerKeySettings } from '@/lib/settings';
import { notify } from '@/lib/toast';
import { cn } from '@/lib/utils';

// The three view panels and the drawer load on demand. A visitor who only remaps
// keys never downloads the calendar, the lighting controls or the probes.
const AdvancedDrawer = lazy(() =>
  import('@/features/advanced/AdvancedDrawer').then((module) => ({
    default: module.AdvancedDrawer,
  })),
);

const ScreenPanel = lazy(() =>
  import('@/features/screen/ScreenPanel').then((module) => ({ default: module.ScreenPanel })),
);

const LightingPanel = lazy(() =>
  import('@/features/lighting/LightingPanel').then((module) => ({
    default: module.LightingPanel,
  })),
);

const DevicePanel = lazy(() =>
  import('@/features/device/DevicePanel').then((module) => ({ default: module.DevicePanel })),
);

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="mt-5 flex min-h-40 items-center justify-center rounded-panel border border-line bg-surface text-xs text-muted">
      Loading the {label} panel…
    </div>
  );
}

function loadInitialState(storage: StorageLike | null): EditorState {
  if (!storage) return createInitialState();
  try {
    return createInitialState(loadLayers(storage));
  } catch {
    return createInitialState();
  }
}

export function App() {
  const storage = useMemo<StorageLike | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }, []);

  const [state, dispatch] = useReducer(editorReducer, storage, loadInitialState);
  const { entries, log, clear: clearLog } = useLog();

  // Both layers live in this state, not in the keyboard: reloading must show the
  // same pending changes. `applied` only moves on a confirmed commit, so the
  // pending mark stays honest across a reload.
  useEffect(() => {
    if (!storage) return;
    try {
      saveLayers(storage, state);
    } catch {
      if (!storageWarning.current) {
        storageWarning.current = true;
        log('This browser cannot remember edits. They will be lost on reload.', 'warn');
      }
    }
  }, [state, storage, log]);
  const device = useDevice({ log });
  const { busy, isBusy, run: runLocked, set: setLockBusy } = useBusyLock();
  const storageWarning = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The drawer mounts on first use and stays mounted, so closing it can animate
  // out through Radix Presence instead of vanishing.
  const [advancedMounted, setAdvancedMounted] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // The drawer mounts on first use and stays mounted, so closing it can animate
  // out through Radix Presence instead of vanishing.
  const [logMounted, setLogMounted] = useState(false);
  const view = useSettings((settings) => settings.view);
  const deviceLastSent = useSettings((settings) => settings.deviceLastSent);
  const settings = useSettings((stored) => stored);
  const [timeStatus, setTimeStatus] = useState<TimeStatus>({ kind: 'idle' });
  const [lightingStatus, setLightingStatus] = useState<LightingStatus>({ kind: 'idle' });
  const [perKeyStatus, setPerKeyStatus] = useState<PerKeyStatus>({ kind: 'idle' });
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>({ kind: 'idle' });
  const [animationStatus, setAnimationStatus] = useState<ScreenStatus>({ kind: 'idle' });
  const [animationSending, setAnimationSending] = useState(false);
  const [animationProgress, setAnimationProgress] = useState<{
    readonly sent: number;
    readonly total: number;
  } | null>(null);

  const transfer = useMemo(() => {
    if (!device.device || device.link !== 'usb') return null;
    const config = new HidClient(device.device);
    const screen = device.screenDevice ? new HidClient(device.screenDevice) : null;
    return new TransferService(config, realClock, log, screen ?? undefined);
  }, [device.device, device.screenDevice, device.link, log]);

  // The receiver takes records over output reports and applies patches silently.
  const wireless = useMemo(
    () =>
      device.device && device.link === 'wireless' ? new WirelessClient(device.device, log) : null,
    [device.device, device.link, log],
  );

  // The receiver stops taking records after a quiet spell, so beat on a timer
  // while the link is open, as the vendor app does.
  useEffect(() => {
    if (!wireless) return;
    wireless.startBeating();
    return () => wireless.stopBeating();
  }, [wireless]);

  const rows = getActiveRows(state);
  const selectedRow = getSelectedRow(state);
  const pendingRows = getPendingRows(state);
  const pendingCount = pendingRows.length;
  const connected = device.status === 'connected' && device.link !== null;
  const locked = selectedRow ? state.layer === 'fn' && FN_LOCKED.has(selectedRow.idx) : false;

  const sendRows = useCallback(
    async (rowsToSend: readonly EditorRow[], layer: Layer, afterState: EditorState) => {
      if (!transfer && !wireless) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return false;
      }

      const sent = await runLocked(async () => {
        try {
          const table = buildTable(rowsToSend, { layerFn: layer === 'fn' });

          if (wireless) {
            // One patch per key; the receiver applies them as they arrive and
            // sends nothing back, so `applied` moves on a send, not a reply.
            const patches = pendingKeyPatches(rowsToSend, table);
            const count = await wireless.sendKeys(layer, patches);

            if (count === 0) {
              log('Nothing to send.', 'warn');
              return false;
            }

            dispatch({ type: 'replace', state: afterState });
            log(
              `Sent ${count} key change${count === 1 ? '' : 's'} over 2.4 GHz. The keyboard does not confirm them.`,
              'ok',
            );
            notify.warn(
              `${count} key change${count === 1 ? '' : 's'} sent over 2.4 GHz. The keyboard does not confirm it.`,
            );
            return true;
          }

          // The guard above allows one link or the other; this narrows the type.
          if (!transfer) return false;
          const outcome = classifyTransfer(await transfer.sendTable(table, layer));

          if (outcome.kind === 'busy') {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return false;
          }

          if (outcome.kind === 'failed') {
            log('The keyboard refused the transfer. Nothing was written.', 'err');
            notify.err('The keyboard refused the transfer. Nothing was written.');
            return false;
          }

          if (outcome.kind === 'confirmed') {
            // The settings effect writes both layers once `applied` moves here.
            dispatch({ type: 'replace', state: afterState });

            log(`Upload accepted. The ${layer === 'fn' ? 'Fn layer' : 'top layer'} is live.`, 'ok');
            notify.ok(`Upload accepted. The ${layer === 'fn' ? 'Fn layer' : 'top layer'} is live.`);
            return true;
          }

          log(
            `Upload rejected (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }). Nothing was applied.`,
            'err',
          );
          notify.err('Upload rejected. Nothing was applied.');
          return false;
        } catch (error) {
          log(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, 'err');
          notify.err('The upload failed. Nothing was written.');
          return false;
        }
      });

      return sent ?? false;
    },
    [dispatch, log, runLocked, transfer, wireless],
  );

  const handleUsage = useCallback(
    (usage: number, media: boolean) => {
      if (isBusy()) return false;
      const check = validateUsage(state, usage, media);
      if (!check.ok) {
        log(check.message, 'warn');
        return false;
      }
      dispatch({ type: 'usage', usage, media });
      return true;
    },
    [isBusy, log, state],
  );

  const handleReset = useCallback(() => {
    if (isBusy()) return;
    dispatch({ type: 'reset-selected' });
  }, [isBusy]);

  const handleLayer = useCallback(
    (layer: Layer) => {
      if (isBusy()) return;
      dispatch({ type: 'layer', layer });
    },
    [isBusy],
  );

  const handleSelect = useCallback(
    (idx: number) => {
      if (isBusy()) return;
      dispatch({ type: 'select', idx });
    },
    [isBusy],
  );

  const handleUpload = useCallback(() => {
    if ((!transfer && !wireless) || isBusy() || pendingCount === 0) return;
    const after = editorReducer(state, { type: 'uploaded' });
    void sendRows(getActiveRows(state), state.layer, after);
  }, [isBusy, pendingCount, sendRows, state, transfer, wireless]);

  const handleRestore = useCallback(() => {
    if ((!transfer && !wireless) || isBusy()) return;
    setConfirming(true);
  }, [isBusy, transfer, wireless]);

  const handleConfirmRestore = useCallback(() => {
    if ((!transfer && !wireless) || isBusy()) return;
    setConfirming(false);

    const restored = editorReducer(state, { type: 'restore-layer' });
    dispatch({ type: 'replace', state: restored });
    const after = editorReducer(restored, { type: 'uploaded' });
    void sendRows(getActiveRows(restored), restored.layer, after);
  }, [isBusy, sendRows, state, transfer, wireless]);

  const handleCancelRestore = useCallback(() => setConfirming(false), []);

  const handleSendTime = useCallback(
    async (at: Date) => {
      if (!transfer && !wireless) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return;
      }

      await runLocked(async () => {
        setTimeStatus({ kind: 'idle' });

        const sent = () => {
          setTimeStatus({ kind: 'ok', at });
          log(`Time sent. The screen clock is set to ${formatClock(at)}.`, 'ok');
          notify.ok(`Time sent. The screen clock is set to ${formatClock(at)}.`);
        };

        try {
          if (wireless) {
            await wireless.sendClock(buildTimePacket(at));
            sent();
            return;
          }

          if (!transfer) return;
          const outcome = classifyTransfer(await transfer.sendTime(at));

          if (outcome.kind === 'busy') {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return;
          }

          if (outcome.kind === 'confirmed') {
            sent();
            return;
          }

          if (outcome.kind === 'failed') {
            setTimeStatus({
              kind: 'err',
              message: 'The keyboard refused the time. Nothing changed.',
            });
            log('The keyboard refused the time. Nothing changed.', 'err');
            notify.err('The keyboard refused the time. Nothing changed.');
            return;
          }

          const silent = outcome.status === null;
          setTimeStatus({
            kind: 'err',
            message: silent
              ? 'No reply from the keyboard. Nothing changed.'
              : 'The keyboard refused the time. Nothing changed.',
          });
          log(
            `Time rejected (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }). Nothing changed.`,
            'err',
          );
          notify.err(
            silent
              ? 'No reply from the keyboard. Nothing changed.'
              : 'The keyboard refused the time. Nothing changed.',
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setTimeStatus({ kind: 'err', message: 'The time could not be sent. Nothing changed.' });
          log(`Time failed: ${message}`, 'err');
          notify.err('The time could not be sent. Nothing changed.');
        }
      });
    },
    [log, runLocked, transfer, wireless],
  );

  const handleSendAnimation = useCallback(
    async (frames: Uint8Array[], delays: number[]) => {
      if (!transfer) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return;
      }

      await runLocked(async () => {
        setAnimationStatus({ kind: 'idle' });
        setAnimationProgress(null);
        setAnimationSending(true);

        let sentBlocks = 0;

        try {
          const payload = buildAnimationPayload({ frames, delaysMs: delays });
          const outcome = classifyTransfer(
            await transfer.sendAnimation(payload, {
              onProgress: (sent, total) => {
                sentBlocks = sent;
                setAnimationProgress({ sent, total });
              },
            }),
          );

          if (outcome.kind === 'busy') {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return;
          }

          if (outcome.kind === 'failed') {
            const done = Math.max(0, Math.floor((sentBlocks - 1) / 8));
            setAnimationStatus({
              kind: 'err',
              message: `The upload stopped after ${done} of ${frames.length} frames. Unplug and replug the keyboard if it stops responding, then send the animation again.`,
            });
            log('The screen upload stopped early. The commit was not sent.', 'err');
            notify.err(`The upload stopped after ${done} of ${frames.length} frames.`);
            return;
          }

          if (outcome.kind === 'confirmed') {
            setAnimationStatus({
              kind: 'ok',
              message: 'Sent. The screen is playing the animation.',
            });
            log(
              `Screen animation sent (${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}).`,
              'ok',
            );
            notify.ok(
              `Animation sent, ${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}.`,
            );
            return;
          }

          setAnimationStatus({
            kind: 'err',
            message:
              'The keyboard refused the commit. The screen may show a mix of the old and new animation; send another one to replace it.',
          });
          log(
            `Screen animation rejected (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }). The screen may hold a mix of old and new frames.`,
            'err',
          );
          notify.err('The keyboard refused the animation. The screen may hold a mix of frames.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setAnimationStatus({
            kind: 'err',
            message:
              'The upload stopped unexpectedly. If the keyboard stops responding, unplug and replug it, then send the animation again.',
          });
          log(`Screen upload failed: ${message}`, 'err');
          notify.err('The animation could not be sent.');
        } finally {
          setAnimationSending(false);
          setAnimationProgress(null);
        }
      });
    },
    [log, runLocked, transfer],
  );

  const handleApplyLight = useCallback(
    async (values: LightingValues) => {
      const { mode, color, brightness, speed, colorful, direction } = values;
      if (!transfer && !wireless) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return;
      }

      await runLocked(async () => {
        setLightingStatus({ kind: 'idle' });

        const accepted = () => {
          const { message, log: line } = describeLight(values);
          setLightingStatus({ kind: 'ok', message });
          log(line, 'ok');
          notify.ok(message);
        };

        try {
          const record = buildLightRecord({
            mode,
            r: Number.parseInt(color.slice(1, 3), 16),
            g: Number.parseInt(color.slice(3, 5), 16),
            b: Number.parseInt(color.slice(5, 7), 16),
            brightness,
            speed,
            colorful,
            direction,
          });

          if (wireless) {
            await wireless.sendLight(record);
            accepted();
            return;
          }

          if (!transfer) return;
          const outcome = classifyTransfer(await transfer.sendLighting(record));

          if (outcome.kind === 'busy') {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return;
          }

          if (outcome.kind === 'confirmed') {
            accepted();
            return;
          }

          if (outcome.kind === 'failed') {
            setLightingStatus({
              kind: 'err',
              message: 'The light may not have been sent. Check the keyboard before trying again.',
            });
            log('The light transfer stopped early. Check the keyboard.', 'err');
            notify.err('The light may not have been sent. Check the keyboard.');
            return;
          }

          setLightingStatus({
            kind: 'err',
            message:
              'The keyboard did not confirm the light. It may have applied anyway; check the keys and apply again if not.',
          });
          log(
            `Light not confirmed (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }). It may still have applied.`,
            'err',
          );
          notify.warn('The keyboard did not confirm the light. Check it before trying again.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLightingStatus({
            kind: 'err',
            message: 'The light could not be sent. Nothing changed.',
          });
          log(`Light failed: ${message}`, 'err');
          notify.err('The light could not be sent.');
        }
      });
    },
    [log, runLocked, transfer, wireless],
  );

  const handleApplyPerKey = useCallback(
    async (values: PerKeySettings) => {
      if (!transfer && !wireless) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return;
      }

      await runLocked(async () => {
        setPerKeyStatus({ kind: 'idle' });

        try {
          const colours = new Map<number, string>();
          for (const [id, colour] of Object.entries(values.colors)) {
            colours.set(Number(id), colour);
          }

          const trigger = buildPerKeyTrigger(values.brightness);
          const table = buildPerKeyTable(colours);
          const markSent = () =>
            updateSettings({
              perKey: { ...values, sent: values.colors, sentBrightness: values.brightness },
            });

          if (wireless) {
            // The receiver applies the frames as they arrive and sends nothing
            // back, so `sent` moves on the write, not on a reply.
            const frames = await wireless.sendPerKey(trigger, table);
            markSent();

            const { message, log: line } = describePerKey(colours.size, values.brightness);
            setPerKeyStatus({
              kind: 'ok',
              message: `${message} The receiver does not confirm the map.`,
            });
            log(`${line} Sent in ${frames} frames; the receiver does not confirm it.`, 'ok');
            notify.warn(
              `${colours.size} key change${colours.size === 1 ? '' : 's'} sent over 2.4 GHz. The keyboard does not confirm them.`,
            );
            return;
          }

          // The guard above allows one link or the other; this narrows the type.
          if (!transfer) return;
          const result = await transfer.sendPerKey(trigger, table);

          if (result.busy) {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return;
          }

          // No table means the mode switch was refused, so nothing was painted.
          if (!result.table) {
            setPerKeyStatus({
              kind: 'err',
              message: 'The keyboard refused per-key mode. Nothing was painted.',
            });
            log('The keyboard refused the per-key mode. Nothing was painted.', 'err');
            notify.err('The keyboard refused per-key mode. Nothing was painted.');
            return;
          }

          const outcome = classifySteps(result.table);

          if (outcome.kind === 'confirmed') {
            // Only a confirmed commit moves what the panel believes is on the board.
            markSent();
            const { message, log: line } = describePerKey(colours.size, values.brightness);
            setPerKeyStatus({ kind: 'ok', message });
            log(line, 'ok');
            notify.ok(message);
            return;
          }

          if (outcome.kind === 'failed') {
            setPerKeyStatus({
              kind: 'err',
              message: 'The colours may not have been sent. Check the board before trying again.',
            });
            log('The per-key transfer stopped early. The board may hold a mix of colours.', 'err');
            notify.err('The colours may not have been sent.');
            return;
          }

          if (outcome.kind !== 'rejected') return;
          setPerKeyStatus({
            kind: 'err',
            message:
              'The keyboard did not confirm the colours. The board may still show the previous map; apply again to replace it.',
          });
          log(
            `Per-key colours not confirmed (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }).`,
            'err',
          );
          notify.warn(
            'The keyboard did not confirm the colours. Apply again if the board looks wrong.',
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setPerKeyStatus({
            kind: 'err',
            message: 'The colours could not be sent. If the board looks wrong, apply again.',
          });
          log(`Per-key colours failed: ${message}`, 'err');
          notify.err('The colours could not be sent.');
        }
      });
    },
    [log, runLocked, transfer, wireless],
  );

  const handleApplySettings = useCallback(
    async (values: DeviceSettings) => {
      if (!transfer && !wireless) {
        log('Connect the keyboard first.', 'warn');
        notify.warn('Connect the keyboard first.');
        return;
      }

      await runLocked(async () => {
        setDeviceStatus({ kind: 'idle' });

        const accepted = () => {
          const { message, log: line } = describeSettings(values);
          setDeviceStatus({ kind: 'ok', message });
          log(line, 'ok');
          notify.ok(message);
          updateSettings({ deviceLastSent: { values, at: Date.now() } });
        };

        try {
          const record = buildSettingsRecord(values);

          if (wireless) {
            await wireless.sendSettings(record);
            accepted();
            return;
          }

          if (!transfer) return;
          const outcome = classifyTransfer(await transfer.sendSettings(record));

          if (outcome.kind === 'busy') {
            log('A transfer is already running.', 'warn');
            notify.warn('A transfer is already running.');
            return;
          }

          if (outcome.kind === 'confirmed') {
            accepted();
            return;
          }

          if (outcome.kind === 'failed') {
            setDeviceStatus({
              kind: 'err',
              message:
                'The settings may not have been sent. Check the shortcuts before trying again.',
            });
            log('The settings transfer stopped early. Check the keyboard.', 'err');
            notify.err('The settings may not have been sent. Check the shortcuts.');
            return;
          }

          setDeviceStatus({
            kind: 'err',
            message:
              'The keyboard did not confirm the settings. They may have applied anyway; check the shortcuts and apply again if not.',
          });
          log(
            `Device settings not confirmed (${
              outcome.status === null ? 'no reply' : `0x${hex([outcome.status])}`
            }). They may still have applied.`,
            'err',
          );
          notify.warn('The keyboard did not confirm the settings. Check the shortcuts.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setDeviceStatus({
            kind: 'err',
            message: 'The settings could not be sent. Nothing changed.',
          });
          log(`Settings failed: ${message}`, 'err');
          notify.err('The settings could not be sent.');
        }
      });
    },
    [log, runLocked, transfer, wireless],
  );

  const handleOpenAdvanced = useCallback(() => {
    if (!connected || isBusy()) return;
    setAdvancedMounted(true);
    setAdvancedOpen(true);
  }, [connected, isBusy]);

  const handleCloseAdvanced = useCallback(() => setAdvancedOpen(false), []);

  const handleOpenLog = useCallback(() => {
    setLogMounted(true);
    setLogOpen(true);
  }, []);

  const handleAdvancedBusy = useCallback(
    (value: boolean) => {
      setLockBusy(value);
    },
    [setLockBusy],
  );

  const runConnect = useCallback(
    async (options?: ConnectOptions) => {
      const outcome = await device.connect(options);

      if (outcome.status === 'connected') {
        if (outcome.link === 'wireless') {
          notify.ok(`${outcome.name} connected over 2.4 GHz.`);
        } else if (outcome.link === 'usb') {
          notify.ok(`${outcome.name} connected over USB.`);
        } else {
          notify.warn('The device opened, but neither interface was found.');
        }
      } else if (outcome.status === 'cancelled') {
        notify.info('No keyboard selected.');
      } else {
        notify.err(outcome.message);
      }

      // The drawer is only reachable while connected, so warm its chunk now and
      // the first click opens it without a fetch.
      void import('@/features/advanced/AdvancedDrawer').catch(() => {});
    },
    [device],
  );

  const handleConnect = useCallback(() => runConnect(), [runConnect]);
  const handleChooseAnother = useCallback(() => runConnect({ picker: true }), [runConnect]);

  const handleDisconnect = useCallback(async () => {
    await device.disconnect();
    notify.info('Disconnected.');
  }, [device]);

  const handleExportProfile = useCallback(() => {
    const at = new Date();
    downloadText(profileFileName(at), buildProfile(state, settings, at));
    notify.ok('Profile exported.');
  }, [settings, state]);

  const handleImportProfile = useCallback(
    (profile: ParsedProfile) => {
      if (isBusy()) {
        notify.warn('Finish the current transfer first.');
        return;
      }

      const next = createInitialState({
        top: { draft: profile.top, applied: new Map<number, FnOverride>() },
        fn: { draft: profile.fn, applied: new Map<number, FnOverride>() },
      });

      dispatch({ type: 'replace', state: { ...next, layer: state.layer, selected: null } });
      updateSettings({
        device: profile.device,
        lighting: profile.lighting,
        // A profile carries drafts, so nothing imported counts as sent.
        perKey: { ...profile.perKey, sent: {}, sentBrightness: null },
        clock: { mode: profile.clockMode },
      });

      const keys = profile.top.size + profile.fn.size;
      const painted = Object.keys(profile.perKey.colors).length;
      const parts: string[] = [];
      if (keys) parts.push(`${keys} key change${keys === 1 ? '' : 's'}`);
      if (painted) parts.push(`${painted} painted key${painted === 1 ? '' : 's'}`);
      notify.ok(`Profile loaded: ${parts.join(' and ') || 'no changes'}. Nothing sent.`);
    },
    [isBusy, state.layer],
  );

  // A connected link is not a problem, so only the failures take the error
  // styling. The 2.4 GHz note is neutral, and the screen caveat lives on the
  // Screen tab rather than in this line.
  const banner: { readonly tone: 'error' | 'info'; readonly text: string } | null =
    !device.supported
      ? {
          tone: 'error',
          text: 'WebHID is not available in this browser. Use Chrome, Edge or Opera on desktop.',
        }
      : device.error
        ? { tone: 'error', text: device.error }
        : device.status === 'connected' && device.link === 'wireless'
          ? {
              tone: 'info',
              text: 'Connected over 2.4 GHz. Key changes go one at a time and the keyboard does not confirm them. If it has gone to sleep, press a key first.',
            }
          : device.status === 'connected' && device.link === null
            ? {
                tone: 'error',
                text: 'The configuration interface was not found. Use USB mode and close the vendor app.',
              }
            : null;

  return (
    <div className="flex min-h-screen flex-col bg-ink text-ivory">
      {/* The header carries the working title at small sizes; this gives the page
          one heading that names the device and what the tool does. */}
      <h1 className="sr-only">AJAZZ AK820 Pro keyboard driver and configurator</h1>
      <AppHeader
        device={device}
        supported={device.supported}
        canReconnect={device.canReconnect}
        busy={busy}
        onConnect={handleConnect}
        onChooseAnother={handleChooseAnother}
        onDisconnect={handleDisconnect}
        onAdvanced={handleOpenAdvanced}
        advancedDisabled={!connected || busy}
        profileDisabled={busy}
        onExportProfile={handleExportProfile}
        onImportProfile={handleImportProfile}
        onOpenLog={handleOpenLog}
      />

      {/* Above the connection banner: a build that is one release behind is the
          more important thing to say, and it outlives a reconnect. */}
      <UpdateNotice />

      {banner ? (
        <div
          className={cn(
            'border-b text-sm',
            banner.tone === 'error'
              ? 'border-rust/40 bg-rust/10 text-rust'
              : 'border-brass/40 bg-brass/10 text-brass',
          )}
        >
          <p className="mx-auto w-full max-w-page px-4 py-2">{banner.text}</p>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-page flex-1 px-4 py-6">
        <Tabs value={view} onValueChange={(next) => updateSettings({ view: next as View })}>
          <ViewTabs view={view} disabled={busy} />

          <TabsContent value="keys">
            <div className="mt-5 grid content-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="flex min-w-0 flex-col gap-4">
                <Tabs value={state.layer} onValueChange={(next) => handleLayer(next as Layer)}>
                  <LayerTabs layer={state.layer} disabled={busy} />
                  <TabsContent value="top" className="mt-4">
                    <KeymapBoard
                      rows={rows}
                      layer={state.layer}
                      selected={state.selected}
                      disabled={busy}
                      onSelect={handleSelect}
                    />
                  </TabsContent>
                  <TabsContent value="fn" className="mt-4">
                    <KeymapBoard
                      rows={rows}
                      layer={state.layer}
                      selected={state.selected}
                      disabled={busy}
                      onSelect={handleSelect}
                    />
                  </TabsContent>
                </Tabs>
                <PendingBar
                  layer={state.layer}
                  pending={pendingRows}
                  connected={connected}
                  busy={busy}
                  confirming={confirming}
                  onUpload={handleUpload}
                  onRestore={handleRestore}
                  onConfirmRestore={handleConfirmRestore}
                  onCancelRestore={handleCancelRestore}
                />
              </section>

              <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
                <KeyInspector
                  row={selectedRow}
                  layer={state.layer}
                  locked={locked}
                  disabled={busy}
                  onUsage={handleUsage}
                  onReset={handleReset}
                  onInvalid={(message) => log(message, 'warn')}
                />
                <WriteRules />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="screen">
            <Suspense fallback={<PanelLoading label="screen" />}>
              <ScreenPanel
                connected={connected}
                screenReady={device.screenFound}
                busy={busy}
                status={timeStatus}
                animationStatus={animationStatus}
                animationProgress={animationProgress}
                animationSending={animationSending}
                onSend={handleSendTime}
                onSendAnimation={handleSendAnimation}
                wireless={device.link === 'wireless'}
              />
            </Suspense>
          </TabsContent>

          <TabsContent value="light">
            <Suspense fallback={<PanelLoading label="lighting" />}>
              <LightingPanel
                connected={connected}
                busy={busy}
                status={lightingStatus}
                perKeyStatus={perKeyStatus}
                onApply={handleApplyLight}
                onApplyPerKey={handleApplyPerKey}
              />
            </Suspense>
          </TabsContent>

          <TabsContent value="device">
            <Suspense fallback={<PanelLoading label="device" />}>
              <div className="mt-5 grid content-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                <DevicePanel
                  connected={connected}
                  busy={busy}
                  status={deviceStatus}
                  wireless={device.link === 'wireless'}
                  lastSent={deviceLastSent}
                  onApply={handleApplySettings}
                />
              </div>
            </Suspense>
          </TabsContent>
        </Tabs>
      </main>

      <PageFooter />

      {logMounted ? (
        <LogDrawer open={logOpen} onOpenChange={setLogOpen} entries={entries} onClear={clearLog} />
      ) : null}

      {advancedMounted ? (
        <Suspense fallback={null}>
          <AdvancedDrawer
            open={advancedOpen}
            device={device.device}
            log={log}
            onClose={handleCloseAdvanced}
            onBusyChange={handleAdvancedBusy}
          />
        </Suspense>
      ) : null}

      <Toaster />
    </div>
  );
}
