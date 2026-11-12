import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

function sendText(socket, value) {
  socket.write(frame(1, Buffer.from(JSON.stringify(value))));
}

function sendBinary(socket, bytes) {
  socket.write(frame(2, bytes));
}

function tone(samples = 6000) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / 24000) * 6000), index * 2);
  }
  return buffer;
}

export function attachMockRealtime(server) {
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith("/functions/v1/app") || url.searchParams.get("action") !== "realtime") {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    if (process.env.MOCK_REALTIME_AUTH === "1") {
      setTimeout(() => {
        sendText(socket, {
          type: "error",
          code: "upstream_auth",
          message: "The live service rejected the service key.",
          fatal: true,
        });
        socket.write(frame(8, Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from("upstream_auth")])));
        socket.end();
      }, 50);
      return;
    }

    let buffer = Buffer.alloc(0);
    let frames = 0;
    let responded = false;
    let closed = false;

    setTimeout(() => sendText(socket, { type: "ready", model: "qwen-audio-3.1-realtime-flash", voice: "longanqian" }), 50);
    setTimeout(() => sendText(socket, { type: "state", value: "listening" }), 80);

    const reply = () => {
      if (responded || closed) return;
      responded = true;
      sendText(socket, { type: "state", value: "thinking" });
      sendText(socket, { type: "caption", delta: "Hola, " });
      sendText(socket, { type: "caption", delta: "esto es una prueba." });
      sendText(socket, { type: "state", value: "speaking" });
      sendBinary(socket, tone(6000));
      sendBinary(socket, tone(6000));
      sendBinary(socket, tone(6000));
      sendBinary(socket, tone(6000));
      sendText(socket, {
        type: "turn",
        text: "Hola, esto es una prueba.",
        firstAudioMs: 900,
        turnMs: 1500,
      });
      sendText(socket, { type: "state", value: "listening" });
      setTimeout(() => {
        responded = false;
      }, 1500);
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;

        const payload = buffer.subarray(offset, offset + length);
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4);
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }
        buffer = buffer.subarray(offset + length);

        if (opcode === 8) {
          closed = true;
          socket.end();
          return;
        }
        if (opcode === 9) {
          socket.write(frame(10, payload));
          continue;
        }
        if (opcode === 2) {
          frames += 1;
          if (frames >= 3) reply();
        }
      }
    });

    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => {
      closed = true;
    });
  });
}
