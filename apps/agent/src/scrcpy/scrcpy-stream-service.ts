import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { AgentPaths } from "@device-robot/config";
import { AdbServerClient, type Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import {
  AndroidKeyEventAction,
  AndroidKeyCode,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyVideoCodecId,
  h264ParseConfiguration,
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";

import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";

const SCRCPY_SERVER_VERSION = "3.3.3";
const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
const SCRCPY_SERVER_FILENAME = `scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
const SESSION_IDLE_TIMEOUT_MS = 1_500;

export class ScrcpyStreamError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export type ScrcpyStreamSubscriber = {
  send(data: string | Uint8Array, binary: boolean): void;
};

export type ScrcpyControlCommand =
  | {
      type: "pointer";
      action: "down" | "move" | "up" | "cancel";
      pointerId: number;
      x: number;
      y: number;
      videoWidth: number;
      videoHeight: number;
    }
  | { type: "back" }
  | { type: "key"; key: "home" | "recentApps" | "volumeUp" | "volumeDown" };

export interface ScrcpyStreamService {
  subscribe(serial: string, subscriber: ScrcpyStreamSubscriber): Promise<() => void>;
  control(serial: string, command: ScrcpyControlCommand): Promise<void>;
  dispose(): Promise<void>;
}

export type AdbScrcpyStreamServiceOptions = {
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  serverPath?: string;
  downloadServer?: (url: string) => Promise<Uint8Array>;
  adbServer?: AdbServerClient;
};

type ScrcpySession = {
  serial: string;
  adb: Adb;
  client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>;
  controller: ScrcpyControlMessageWriter;
  reader: {
    read(): Promise<{ done: boolean; value?: ScrcpyMediaStreamPacket | undefined }>;
    cancel(): Promise<void>;
  };
  subscribers: Map<ScrcpyStreamSubscriber, { awaitingKeyframe: boolean }>;
  configuration?: string;
  pump?: Promise<void>;
  closeTimer?: NodeJS.Timeout | undefined;
  closed: boolean;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReadyState(state: string): boolean {
  return state === "device" || state === "emulator";
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isPointerId(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
  );
}

export function parseScrcpyControlCommand(value: unknown): ScrcpyControlCommand | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (message.type === "back") {
    return { type: "back" };
  }

  if (
    message.type === "key" &&
    (message.key === "home" ||
      message.key === "recentApps" ||
      message.key === "volumeUp" ||
      message.key === "volumeDown")
  ) {
    return { type: "key", key: message.key };
  }

  if (
    message.type !== "pointer" ||
    (message.action !== "down" &&
      message.action !== "move" &&
      message.action !== "up" &&
      message.action !== "cancel") ||
    !isPointerId(message.pointerId) ||
    !isCoordinate(message.x) ||
    !isCoordinate(message.y) ||
    !isCoordinate(message.videoWidth) ||
    !isCoordinate(message.videoHeight) ||
    message.videoWidth === 0 ||
    message.videoHeight === 0
  ) {
    return undefined;
  }

  return {
    type: "pointer",
    action: message.action,
    pointerId: message.pointerId,
    x: message.x,
    y: message.y,
    videoWidth: message.videoWidth,
    videoHeight: message.videoHeight,
  };
}

function avcConfigurationRecord(configuration: Uint8Array): {
  codec: string;
  description: Uint8Array;
  width: number;
  height: number;
} {
  const parsed = h264ParseConfiguration(configuration);
  const { sequenceParameterSet, pictureParameterSet } = parsed;
  const description = new Uint8Array(11 + sequenceParameterSet.length + pictureParameterSet.length);
  const view = new DataView(description.buffer);

  description[0] = 1;
  description[1] = parsed.profileIndex;
  description[2] = parsed.constraintSet;
  description[3] = parsed.levelIndex;
  description[4] = 0xff;
  description[5] = 0xe1;
  view.setUint16(6, sequenceParameterSet.length, false);
  description.set(sequenceParameterSet, 8);
  const ppsOffset = 8 + sequenceParameterSet.length;
  description[ppsOffset] = 1;
  view.setUint16(ppsOffset + 1, pictureParameterSet.length, false);
  description.set(pictureParameterSet, ppsOffset + 3);

  return {
    codec: `avc1.${parsed.profileIndex.toString(16).padStart(2, "0")}${parsed.constraintSet
      .toString(16)
      .padStart(2, "0")}${parsed.levelIndex.toString(16).padStart(2, "0")}`,
    description,
    width: parsed.croppedWidth,
    height: parsed.croppedHeight,
  };
}

function annexBToAvc(data: Uint8Array): Uint8Array {
  const nalus: Uint8Array[] = [];
  let start = -1;

  for (let index = 0; index <= data.length - 3; index += 1) {
    const threeByteStartCode = data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1;
    const fourByteStartCode =
      index <= data.length - 4 &&
      data[index] === 0 &&
      data[index + 1] === 0 &&
      data[index + 2] === 0 &&
      data[index + 3] === 1;

    if (!threeByteStartCode && !fourByteStartCode) {
      continue;
    }

    if (start >= 0 && index > start) {
      nalus.push(data.subarray(start, index));
    }

    start = index + (fourByteStartCode ? 4 : 3);
    index = start - 1;
  }

  if (start >= 0 && start < data.length) {
    nalus.push(data.subarray(start));
  }

  if (nalus.length === 0) {
    throw new ScrcpyStreamError("scrcpy returned an invalid H.264 frame");
  }

  const result = new Uint8Array(nalus.reduce((total, nalu) => total + 4 + nalu.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const nalu of nalus) {
    view.setUint32(offset, nalu.length, false);
    offset += 4;
    result.set(nalu, offset);
    offset += nalu.length;
  }

  return result;
}

function encodeVideoPacket(packet: Extract<ScrcpyMediaStreamPacket, { type: "data" }>): Uint8Array {
  const frame = annexBToAvc(packet.data);
  const result = new Uint8Array(9 + frame.length);
  const view = new DataView(result.buffer);
  result[0] = packet.keyframe ? 1 : 0;
  view.setBigUint64(1, packet.pts ?? BigInt(Date.now()) * 1_000n, false);
  result.set(frame, 9);
  return result;
}

function configurationMessage(data: Uint8Array): string {
  const configuration = avcConfigurationRecord(data);
  return JSON.stringify({
    type: "configuration",
    codec: configuration.codec,
    description: Buffer.from(configuration.description).toString("base64"),
    width: configuration.width,
    height: configuration.height,
  });
}

async function downloadScrcpyServer(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ScrcpyStreamError(`Unable to download the scrcpy server (HTTP ${response.status})`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength < 10_000) {
    throw new ScrcpyStreamError("The downloaded scrcpy server is incomplete");
  }

  return data;
}

export class AdbScrcpyStreamService implements ScrcpyStreamService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #serverPath: string;
  readonly #downloadServer: (url: string) => Promise<Uint8Array>;
  readonly #adbServer: AdbServerClient;
  readonly #sessions = new Map<string, ScrcpySession>();
  readonly #creating = new Map<string, Promise<ScrcpySession>>();
  #serverReady?: Promise<string> | undefined;

  public constructor(options: AdbScrcpyStreamServiceOptions) {
    this.#deviceService = options.deviceService;
    this.#serverPath =
      options.serverPath ?? join(options.paths.root, "tools", SCRCPY_SERVER_FILENAME);
    this.#downloadServer = options.downloadServer ?? downloadScrcpyServer;
    this.#adbServer =
      options.adbServer ??
      new AdbServerClient(new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5_037 }));
  }

  public async subscribe(serial: string, subscriber: ScrcpyStreamSubscriber): Promise<() => void> {
    const session = await this.#getOrCreateSession(serial);
    if (session.closed) {
      throw new ScrcpyStreamError("The scrcpy session closed before it could be subscribed");
    }

    if (session.closeTimer !== undefined) {
      clearTimeout(session.closeTimer);
      session.closeTimer = undefined;
    }

    session.subscribers.set(subscriber, { awaitingKeyframe: true });
    if (session.configuration !== undefined) {
      subscriber.send(session.configuration, false);
      void session.controller.resetVideo().catch(() => undefined);
    }

    session.pump ??= this.#pump(session);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;
      session.subscribers.delete(subscriber);
      if (session.subscribers.size === 0 && !session.closed) {
        session.closeTimer = setTimeout(() => {
          void this.#closeSession(session);
        }, SESSION_IDLE_TIMEOUT_MS);
      }
    };
  }

  public async control(serial: string, command: ScrcpyControlCommand): Promise<void> {
    const session = this.#sessions.get(serial);
    if (session === undefined || session.closed) {
      throw new ScrcpyStreamError("The scrcpy control channel is not ready");
    }

    if (command.type === "back") {
      await session.controller.backOrScreenOn(AndroidKeyEventAction.Down);
      await session.controller.backOrScreenOn(AndroidKeyEventAction.Up);
      return;
    }

    if (command.type === "key") {
      const keyCode = {
        home: AndroidKeyCode.AndroidHome,
        recentApps: AndroidKeyCode.AndroidAppSwitch,
        volumeUp: AndroidKeyCode.VolumeUp,
        volumeDown: AndroidKeyCode.VolumeDown,
      }[command.key];
      await session.controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
      await session.controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
      return;
    }

    const action = {
      down: AndroidMotionEventAction.Down,
      move: AndroidMotionEventAction.Move,
      up: AndroidMotionEventAction.Up,
      cancel: AndroidMotionEventAction.Cancel,
    }[command.action];
    const pressed = command.action === "down" || command.action === "move";
    await session.controller.injectTouch({
      action,
      pointerId: BigInt(command.pointerId),
      pointerX: command.x,
      pointerY: command.y,
      videoWidth: command.videoWidth,
      videoHeight: command.videoHeight,
      pressure: pressed ? 1 : 0,
      actionButton: command.action === "down" ? AndroidMotionEventButton.Primary : 0,
      buttons: pressed ? AndroidMotionEventButton.Primary : 0,
    });
  }

  public async dispose(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => await this.#closeSession(session)),
    );
  }

  async #getOrCreateSession(serial: string): Promise<ScrcpySession> {
    const existing = this.#sessions.get(serial);
    if (existing !== undefined && !existing.closed) {
      return existing;
    }

    const pending = this.#creating.get(serial);
    if (pending !== undefined) {
      return await pending;
    }

    const creating = this.#createSession(serial);
    this.#creating.set(serial, creating);
    try {
      const session = await creating;
      this.#sessions.set(serial, session);
      return session;
    } finally {
      this.#creating.delete(serial);
    }
  }

  async #createSession(serial: string): Promise<ScrcpySession> {
    await this.#requireReadyDevice(serial);
    const serverPath = await this.#ensureServer();
    const adb = await this.#adbServer.createAdb({ serial });
    let client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>> | undefined;

    try {
      await AdbScrcpyClient.pushServer(adb, Readable.toWeb(createReadStream(serverPath)) as never);
      const options = new AdbScrcpyOptionsLatest(
        {
          audio: false,
          control: true,
          maxFps: 60,
          maxSize: 1_080,
          powerOn: false,
          showTouches: false,
          stayAwake: false,
          tunnelForward: true,
          video: true,
          videoBitRate: 4_000_000,
        },
        { version: SCRCPY_SERVER_VERSION },
      );
      client = await AdbScrcpyClient.start(adb, "/data/local/tmp/scrcpy-server.jar", options);
      const video = await client.videoStream;
      if (video.metadata.codec !== ScrcpyVideoCodecId.H264) {
        throw new ScrcpyStreamError("The connected device did not provide an H.264 scrcpy stream");
      }

      const controller = client.controller;
      if (controller === undefined) {
        throw new ScrcpyStreamError(
          "The connected device did not provide a scrcpy control channel",
        );
      }

      return {
        serial,
        adb,
        client,
        controller,
        reader: video.stream.getReader(),
        subscribers: new Map(),
        closed: false,
      };
    } catch (error) {
      await client?.close().catch(() => undefined);
      await adb.close().catch(() => undefined);
      throw error;
    }
  }

  async #pump(session: ScrcpySession): Promise<void> {
    try {
      while (!session.closed) {
        const { done, value } = await session.reader.read();
        if (done || value === undefined) {
          break;
        }

        if (value.type === "configuration") {
          session.configuration = configurationMessage(value.data);
          this.#broadcastConfiguration(session, session.configuration);
          continue;
        }

        this.#broadcastVideoPacket(session, value);
      }
    } catch (error) {
      if (!session.closed) {
        this.#broadcast(
          session,
          JSON.stringify({
            type: "error",
            message: `scrcpy stream failed: ${toErrorMessage(error)}`,
          }),
          false,
        );
      }
    } finally {
      await this.#closeSession(session);
    }
  }

  #broadcast(session: ScrcpySession, data: string | Uint8Array, binary: boolean): void {
    for (const subscriber of session.subscribers.keys()) {
      try {
        subscriber.send(data, binary);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }

  #broadcastConfiguration(session: ScrcpySession, configuration: string): void {
    for (const [subscriber, state] of session.subscribers) {
      try {
        state.awaitingKeyframe = true;
        subscriber.send(configuration, false);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }

  #broadcastVideoPacket(
    session: ScrcpySession,
    packet: Extract<ScrcpyMediaStreamPacket, { type: "data" }>,
  ): void {
    if (packet.keyframe) {
      for (const state of session.subscribers.values()) {
        state.awaitingKeyframe = false;
      }
    }

    const data = encodeVideoPacket(packet);
    for (const [subscriber, state] of session.subscribers) {
      if (state.awaitingKeyframe) {
        continue;
      }

      try {
        subscriber.send(data, true);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }

  async #closeSession(session: ScrcpySession): Promise<void> {
    if (session.closed) {
      return;
    }

    session.closed = true;
    if (session.closeTimer !== undefined) {
      clearTimeout(session.closeTimer);
      session.closeTimer = undefined;
    }

    if (this.#sessions.get(session.serial) === session) {
      this.#sessions.delete(session.serial);
    }

    await session.reader.cancel().catch(() => undefined);
    await session.client.close().catch(() => undefined);
    await session.adb.close().catch(() => undefined);
  }

  async #ensureServer(): Promise<string> {
    if (existsSync(this.#serverPath)) {
      const details = await stat(this.#serverPath);
      if (details.size >= 10_000) {
        return this.#serverPath;
      }
    }

    this.#serverReady ??= (async () => {
      await mkdir(dirname(this.#serverPath), { recursive: true });
      const data = await this.#downloadServer(SCRCPY_SERVER_URL);
      const temporaryPath = `${this.#serverPath}.download`;
      await writeFile(temporaryPath, data);
      await rename(temporaryPath, this.#serverPath);
      return this.#serverPath;
    })();

    try {
      return await this.#serverReady;
    } catch (error) {
      this.#serverReady = undefined;
      throw error;
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    const response = await this.#deviceService.listDevices();
    if (!response.adb.available) {
      throw new ScrcpyStreamError(response.adb.error ?? "ADB is unavailable");
    }

    if (response.error !== undefined) {
      throw new ScrcpyStreamError(response.error);
    }

    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new ScrcpyStreamError("The requested device is no longer connected");
    }

    if (!isReadyState(device.state)) {
      throw new ScrcpyStreamError(
        `The requested device is not ready for streaming (${device.state})`,
      );
    }
  }
}

export const scrcpyStreamProtocol = {
  annexBToAvc,
  avcConfigurationRecord,
  encodeVideoPacket,
  parseScrcpyControlCommand,
};
