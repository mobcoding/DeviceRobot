import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { AgentPaths } from "@device-robot/config";
import { AdbServerClient, type Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import {
  ScrcpyVideoCodecId,
  h264ParseConfiguration,
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";

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

export interface ScrcpyStreamService {
  subscribe(serial: string, subscriber: ScrcpyStreamSubscriber): Promise<() => void>;
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
  reader: {
    read(): Promise<{ done: boolean; value?: ScrcpyMediaStreamPacket | undefined }>;
    cancel(): Promise<void>;
  };
  subscribers: Set<ScrcpyStreamSubscriber>;
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

    session.subscribers.add(subscriber);
    if (session.configuration !== undefined) {
      subscriber.send(session.configuration, false);
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
          control: false,
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

      return {
        serial,
        adb,
        client,
        reader: video.stream.getReader(),
        subscribers: new Set(),
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
          this.#broadcast(session, session.configuration, false);
          continue;
        }

        this.#broadcast(session, encodeVideoPacket(value), true);
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
    for (const subscriber of session.subscribers) {
      try {
        subscriber.send(data, binary);
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
};
