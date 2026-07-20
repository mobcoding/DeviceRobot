import { describe, expect, it } from "vitest";

import { scrcpyStreamProtocol } from "../src/scrcpy/scrcpy-stream-service.js";

describe("scrcpy stream protocol", () => {
  it("converts Annex B video data to the AVC length-prefixed format", () => {
    const result = scrcpyStreamProtocol.annexBToAvc(
      new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 1, 0x41, 0x9a]),
    );

    expect([...result]).toEqual([0, 0, 0, 3, 0x65, 0x88, 0x84, 0, 0, 0, 2, 0x41, 0x9a]);
  });

  it("adds keyframe and microsecond timestamp metadata to websocket video packets", () => {
    const result = scrcpyStreamProtocol.encodeVideoPacket({
      type: "data",
      keyframe: true,
      pts: 123_456n,
      data: new Uint8Array([0, 0, 1, 0x65, 0x88]),
    });

    expect(result[0]).toBe(1);
    expect(new DataView(result.buffer).getBigUint64(1, false)).toBe(123_456n);
    expect([...result.subarray(9)]).toEqual([0, 0, 0, 2, 0x65, 0x88]);
  });
});
