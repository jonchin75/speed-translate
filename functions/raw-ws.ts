type Listener = (event: unknown) => void;
type MessageListener = (event: { data: string | ArrayBuffer }) => void;
type CloseListener = (event: { code: number; reason: string }) => void;

type RawTransport = {
  write(chunk: Uint8Array): unknown;
  end(): void;
  destroy?(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  setNoDelay?(flag: boolean): void;
};

const OPEN = 1;
const CLOSED = 3;
const MAX_FRAME = 16 * 1024 * 1024;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function headerEnd(buffer: Uint8Array): number {
  for (let index = 3; index < buffer.length; index += 1) {
    if (buffer[index] === 10 && buffer[index - 1] === 13 && buffer[index - 2] === 10 && buffer[index - 3] === 13) {
      return index - 3;
    }
  }
  return -1;
}

export class RawWebSocket {
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = 0;
  #socket: RawTransport;
  #openHandler: Listener | null = null;
  #errorHandler: Listener | null = null;
  #messageHandler: MessageListener | null = null;
  #closeHandler: CloseListener | null = null;
  #pendingMessages: (string | ArrayBuffer)[] = [];
  #closeInfo: { code: number; reason: string } | null = null;
  #closeNotified = false;
  #closeSent = false;
  #buffer = new Uint8Array(0);
  #fragments: Uint8Array[] = [];
  #fragmentOpcode = 0;

  constructor(socket: RawTransport) {
    this.#socket = socket;
  }

  set onopen(handler: Listener | null) {
    this.#openHandler = handler;
  }

  set onerror(handler: Listener | null) {
    this.#errorHandler = handler;
  }

  set onmessage(handler: MessageListener | null) {
    this.#messageHandler = handler;
    if (!handler) return;
    for (const item of this.#pendingMessages.splice(0)) handler({ data: item });
  }

  set onclose(handler: CloseListener | null) {
    this.#closeHandler = handler;
    if (handler) this.#deliverClose();
  }

  markOpen() {
    if (this.readyState !== 0) return;
    this.readyState = OPEN;
    this.#openHandler?.({});
  }

  feed(chunk: Uint8Array) {
    if (!chunk.length) return;
    this.#buffer = concat(this.#buffer, chunk);
    this.#parse();
  }

  send(data: string) {
    this.#frame(0x1, new TextEncoder().encode(data));
  }

  close(code = 1000, reason = "") {
    if (this.#closeSent) return;
    this.#closeSent = true;
    this.#closeInfo = { code, reason };
    const reasonBytes = new TextEncoder().encode(reason).slice(0, 123);
    const payload = new Uint8Array(2 + reasonBytes.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(reasonBytes, 2);
    this.#frame(0x8, payload);
    try {
      this.#socket.end();
    } catch {
      // already closed
    }
    this.readyState = CLOSED;
  }

  socketError() {
    this.#errorHandler?.({});
  }

  socketClosed() {
    this.readyState = CLOSED;
    this.#deliverClose();
  }

  #deliverClose() {
    if (!this.#closeHandler || this.#closeNotified || !this.#closeInfo) return;
    this.#closeNotified = true;
    this.#closeHandler(this.#closeInfo);
  }

  #emit(item: string | ArrayBuffer) {
    if (this.#messageHandler) this.#messageHandler({ data: item });
    else this.#pendingMessages.push(item);
  }

  #parse() {
    for (;;) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = (this.#buffer[2] << 8) | this.#buffer[3];
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + 2, 8);
        const high = view.getUint32(0);
        const low = view.getUint32(4);
        if (high !== 0 || low > MAX_FRAME) {
          this.#fail();
          return;
        }
        length = low;
        offset = 10;
      }
      let mask: Uint8Array | null = null;
      if (masked) {
        if (this.#buffer.length < offset + 4) return;
        mask = this.#buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.#buffer.length < offset + length) return;
      let payload = this.#buffer.subarray(offset, offset + length).slice();
      this.#buffer = this.#buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
      }
      this.#handleFrame(fin, opcode, payload);
    }
  }

  #handleFrame(fin: boolean, opcode: number, payload: Uint8Array) {
    switch (opcode) {
      case 0x0:
      case 0x1:
      case 0x2: {
        if (opcode !== 0x0) this.#fragmentOpcode = opcode;
        this.#fragments.push(payload);
        if (!fin) return;
        const merged = concatAll(this.#fragments);
        this.#fragments = [];
        if (this.#fragmentOpcode === 0x1) this.#emit(new TextDecoder().decode(merged));
        else if (this.#fragmentOpcode === 0x2) this.#emit(merged.slice().buffer);
        return;
      }
      case 0x8: {
        const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
        const reason = payload.length > 2 ? new TextDecoder().decode(payload.subarray(2)) : "";
        this.#closeInfo = { code, reason };
        this.#frame(0x8, payload.slice(0, Math.min(payload.length, 2)));
        try {
          this.#socket.end();
        } catch {
          // already closed
        }
        this.readyState = CLOSED;
        this.#deliverClose();
        return;
      }
      case 0x9:
        this.#frame(0xa, payload);
        return;
      default:
        return;
    }
  }

  #fail() {
    this.readyState = CLOSED;
    this.socketError();
    try {
      this.#socket.destroy?.();
    } catch {
      // already destroyed
    }
  }

  #frame(opcode: number, payload: Uint8Array) {
    const length = payload.length;
    const mask = crypto.getRandomValues(new Uint8Array(4));
    let header: Uint8Array;
    if (length < 126) {
      header = new Uint8Array(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = new Uint8Array(4);
      header[1] = 0x80 | 126;
      header[2] = length >> 8;
      header[3] = length & 0xff;
    } else {
      header = new Uint8Array(10);
      header[1] = 0x80 | 127;
      const view = new DataView(header.buffer);
      view.setUint32(2, 0);
      view.setUint32(6, length);
    }
    header[0] = 0x80 | opcode;
    const body = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) body[index] = payload[index] ^ mask[index & 3];
    this.#socket.write(concat(concat(header, mask), body));
  }
}

function wsKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function openRawWebSocket(url: string, key: string, deadlineMs: number): Promise<RawWebSocket> {
  const target = new URL(url);
  if (target.protocol !== "wss:") throw new Error("unsupported scheme");
  const specifier = "node:tls";
  const tls = (await import(specifier)) as {
    connect(options: { host: string; port: number; servername: string }): RawTransport;
  };
  const socket = tls.connect({ host: target.hostname, port: 443, servername: target.hostname });
  socket.setNoDelay?.(true);

  return await new Promise<RawWebSocket>((resolve, reject) => {
    let settled = false;
    let upgraded = false;
    let headers = new Uint8Array(0);
    const timer = setTimeout(() => finish(new Error("raw handshake timeout")), deadlineMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          socket.destroy?.();
        } catch {
          // already destroyed
        }
        reject(error);
      }
    };

    const request = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      `Authorization: Bearer ${key}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${wsKey()}`,
      "Sec-WebSocket-Version: 13",
      "User-Agent: speech-site",
      "",
      "",
    ].join("\r\n");
    const encoded = new TextEncoder().encode(request);

    socket.on("secureConnect", () => socket.write(encoded));

    socket.on("data", (chunk: Uint8Array) => {
      if (upgraded || settled) return;
      headers = concat(headers, chunk);
      const end = headerEnd(headers);
      if (end === -1) {
        if (headers.length > 16384) finish(new Error("raw handshake too large"));
        return;
      }
      const head = new TextDecoder().decode(headers.subarray(0, end));
      const statusLine = head.split("\r\n")[0] ?? "";
      if (!/ 101 /.test(statusLine)) {
        finish(new Error(`raw status ${statusLine.slice(0, 80)}`));
        return;
      }
      upgraded = true;
      settled = true;
      clearTimeout(timer);
      const wrapper = new RawWebSocket(socket);
      const leftover = headers.subarray(end + 4).slice();
      socket.on("data", (next: Uint8Array) => wrapper.feed(next));
      socket.on("error", () => wrapper.socketError());
      socket.on("close", () => wrapper.socketClosed());
      wrapper.markOpen();
      if (leftover.length) wrapper.feed(leftover);
      resolve(wrapper);
    });

    socket.on("error", () => finish(new Error("raw connection error")));
  });
}
