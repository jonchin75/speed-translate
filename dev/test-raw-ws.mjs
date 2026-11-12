import test from "node:test";
import assert from "node:assert/strict";
import { RawWebSocket } from "../functions/raw-ws.ts";

function fakeTransport() {
  return {
    writes: [],
    ended: false,
    write(chunk) {
      this.writes.push(chunk);
    },
    end() {
      this.ended = true;
    },
    on() {},
  };
}

function frame(opcode, payload, fin = true) {
  const bytes = new TextEncoder().encode(payload);
  return Uint8Array.from([(fin ? 0x80 : 0) | opcode, bytes.length, ...bytes]);
}

test("a text frame is delivered as a string", () => {
  const socket = new RawWebSocket(fakeTransport());
  const seen = [];
  socket.onmessage = (event) => seen.push(event.data);
  socket.feed(frame(0x1, "session.created"));
  assert.deepEqual(seen, ["session.created"]);
});

test("frames split across chunks are reassembled", () => {
  const socket = new RawWebSocket(fakeTransport());
  const seen = [];
  socket.onmessage = (event) => seen.push(event.data);
  const bytes = frame(0x1, "hello");
  socket.feed(bytes.subarray(0, 2));
  assert.deepEqual(seen, []);
  socket.feed(bytes.subarray(2));
  assert.deepEqual(seen, ["hello"]);
});

test("fragmented text frames are joined", () => {
  const socket = new RawWebSocket(fakeTransport());
  const seen = [];
  socket.onmessage = (event) => seen.push(event.data);
  socket.feed(frame(0x1, "he", false));
  socket.feed(frame(0x0, "llo"));
  assert.deepEqual(seen, ["hello"]);
});

test("a ping is answered with a masked pong", () => {
  const transport = fakeTransport();
  const socket = new RawWebSocket(transport);
  socket.feed(frame(0x9, ""));
  assert.equal(transport.writes.length, 1);
  const pong = transport.writes[0];
  assert.equal(pong[0], 0x8a);
  assert.equal(pong[1] & 0x80, 0x80);
});

test("messages that arrive before a handler are replayed", () => {
  const socket = new RawWebSocket(fakeTransport());
  socket.feed(frame(0x1, "early"));
  const seen = [];
  socket.onmessage = (event) => seen.push(event.data);
  assert.deepEqual(seen, ["early"]);
});

test("a close frame notifies once with code and reason", () => {
  const transport = fakeTransport();
  const socket = new RawWebSocket(transport);
  const closes = [];
  socket.onclose = (event) => closes.push(event);
  socket.feed(Uint8Array.from([0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65]));
  socket.socketClosed();
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1000);
  assert.equal(closes[0].reason, "bye");
  assert.equal(socket.readyState, 3);
  assert.equal(transport.ended, true);
});
