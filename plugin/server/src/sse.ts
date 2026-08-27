export type SseFrame = {
  event: string;
  data: string;
};

const MAX_BUFFER_CHARACTERS = 1_048_576;

export class SseParser {
  private buffer = "";
  private started = false;

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.startsWith("\ufeff")) {
        this.buffer = this.buffer.slice(1);
      }
    }
    if (this.buffer.length > MAX_BUFFER_CHARACTERS) {
      this.buffer = "";
      throw new Error("server-sent event frame is too large");
    }
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (boundary === null) {
        break;
      }
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const frame = parseBlock(block);
      if (frame !== null) {
        frames.push(frame);
      }
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  let hasData = false;
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
      hasData = true;
    }
  }
  if (!hasData) {
    return null;
  }
  return { event, data: data.join("\n") };
}
