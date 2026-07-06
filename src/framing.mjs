import { Buffer } from "node:buffer";
import { endianness } from "node:os";

const HEADER_BYTES = 4;
const IS_LITTLE_ENDIAN = endianness() === "LE";

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(HEADER_BYTES + body.length);
  writeFrameLength(frame, body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= HEADER_BYTES) {
    const length = readFrameLength(buffer, offset);
    const frameBytes = HEADER_BYTES + length;
    if (buffer.length - offset < frameBytes) break;

    const json = buffer.subarray(offset + HEADER_BYTES, offset + frameBytes).toString("utf8");
    messages.push(JSON.parse(json));
    offset += frameBytes;
  }

  return { messages, remaining: buffer.subarray(offset) };
}

function readFrameLength(buffer, offset) {
  return IS_LITTLE_ENDIAN ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function writeFrameLength(buffer, length, offset) {
  return IS_LITTLE_ENDIAN ? buffer.writeUInt32LE(length, offset) : buffer.writeUInt32BE(length, offset);
}
