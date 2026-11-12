# Speech Translator

A private Qoder Site for speech translation with two modes:

- **One-shot** (`/`) — record a phrase, get a transcript, a written translation
  and spoken audio.
- **Live interpreter** (`/realtime.html`) — speak continuously; each short pause
  produces a translated spoken phrase with a caption.

The browser talks only to the site's own Deno Edge Function at
`/functions/v1/app`. The function holds the service key and relays to Alibaba
Cloud Model Studio.

![Live interpreter showing a translated caption, microphone and audio meters, and a list of recent translations](docs/screenshot-live.png)

*The live interpreter running against the local preview server and its mock
relay. The deployed site streams from Alibaba Cloud Model Studio instead.*

## What it does

The app turns spoken phrases into another language and speaks the result back.
The one-shot page handles a single phrase and returns three artifacts — the
source transcription, the translated text and synthesized speech — with the
measured ASR, translation and speech latency shown per stage. The live
interpreter keeps the microphone open instead: it detects the end of each
phrase, translates it with the surrounding context, captions it and plays the
translation while the next phrase is being spoken, so a conversation continues
without a stop button. When the translated audio outlasts the source phrase,
playback trims quiet lead-in, drops silent padding and briefly speeds up so it
keeps up with a normal speaking pace.

Both pages translate into English, Mandarin Chinese, Spanish, Japanese, French,
Korean or German. The service key is configured once: a site Secret when one is
set, otherwise a key saved through the top-nav **Settings** dialog. That key
lives in an HttpOnly, SameSite=Strict cookie scoped to the function path, never
in published files or localStorage. The Settings dialog reports whether the
stored key belongs to the workspace the realtime host expects, so a mismatched
key family is caught before a session starts. Audio is sent to Alibaba Cloud
Model Studio for processing; the site does not store recordings.

The site is invite-only (Qoder sign-in) and is served as static files plus one
Edge Function, so no long-running server or WebSocket infrastructure is
deployed.

## Architecture

### System context

```mermaid
flowchart LR
  user["Speaker with headphones"]

  subgraph browser["Browser"]
    oneShot["One-shot page<br/>index.html + app.js"]
    live["Live interpreter<br/>realtime.html + realtime.js"]
    worklet["pcm-worklet.js<br/>16 kHz capture + level meter"]
    policy["playback-policy.js<br/>queue / lead-trim policy"]
    settings["settings.js + settings-state.js<br/>Settings dialog and key state"]
  end

  subgraph qoder["Qoder Site"]
    static["Static web assets"]
    fn["Edge Function<br/>/functions/v1/app"]
    relay["Realtime relay<br/>Deno WebSocket to upstream"]
  end

  subgraph alibaba["Alibaba Cloud Model Studio"]
    asr["qwen-audio-3.0-asr-flash"]
    llm["qwen3.7-plus"]
    tts["qwen-audio-3.0-tts-plus"]
    rt["qwen-audio-3.1-realtime-flash<br/>Realtime WebSocket"]
  end

  user --> browser
  oneShot --> static
  live --> static
  worklet --> live
  live --> policy
  oneShot -- "POST /asr /translate /tts" --> fn
  live -- "WSS action=realtime" --> fn
  fn --> relay
  fn -- HTTPS --> asr
  fn -- HTTPS --> llm
  fn -- HTTPS --> tts
  relay -- "WSS session.append / commit / response.create" --> rt
  rt -- "transcript + PCM16 audio" --> relay
  relay -- "captions + PCM16 audio" --> live
```

The model names above are fixed in source. The browser cannot select a different
upstream host or model.

### Components

```mermaid
flowchart TB
  subgraph web["web/ — static, published"]
    index["index.html"]
    appjs["app.js<br/>recording, WAV encode, one-shot pipeline"]
    rhtml["realtime.html"]
    rjs["realtime.js<br/>session lifecycle, VAD, playback scheduler"]
    worklet["pcm-worklet.js<br/>resample to 16 kHz, 100 ms frames"]
    policy["playback-policy.js<br/>pure playback decision function"]
    settings["settings.js<br/>Settings dialog, key save / forget"]
    sstate["settings-state.js<br/>pure key-state view model"]
    styles["styles.css"]
  end

  subgraph functions["functions/ — Deno Edge Function"]
    entry["index.ts<br/>Deno.serve(handler)"]
    handler["handler.ts<br/>HTTP routes + upgrade router"]
    shared["shared.ts<br/>languages, key state, errors, env"]
    relay["realtime.ts<br/>validation, limits, relay, turn control"]
    rmap["realtime-map.ts<br/>session.update and upstream event projection"]
    rawws["raw-ws.ts<br/>RFC 6455 client over node:tls"]
  end

  subgraph dev["dev/ — local only, never published"]
    server["server.mjs<br/>static server + handler + optional mock"]
    mock["mock-realtime.mjs"]
    tests["test-*.mjs, verify-handler.mjs"]
  end

  index --> appjs
  rhtml --> rjs
  rjs --> worklet
  rjs --> policy
  appjs --> settings
  rjs --> settings
  settings --> sstate
  entry --> handler
  handler --> shared
  handler --> relay
  relay --> rmap
  relay --> rawws
  relay --> shared
  server --> handler
  server --> mock
  tests --> functions
```

### Deployment topology

```mermaid
flowchart LR
  browser["User browser<br/>speech-translator-es3ao1wi40x.qoder.website"]

  subgraph qoder["Qoder Sites"]
    static["Static hosting<br/>HTML, JS, CSS, worklet"]
    edge["Edge Function /functions/v1/app<br/>Deno runtime"]
  end

  subgraph ali["Alibaba Cloud Model Studio"]
    gw["Token Plan gateway<br/>token-plan.ap-southeast-1.maas.aliyuncs.com"]
    rtw["Realtime WebSocket<br/>ws-zfdxfuu20cq238m5.ap-southeast-1.maas.aliyuncs.com"]
  end

  browser -- HTTPS --> static
  browser -- "HTTPS /key /asr /translate /tts" --> edge
  browser -- "WSS ?action=realtime" --> edge
  edge -- HTTPS --> gw
  edge -- WSS --> rtw
```

The realtime relay uses a dedicated WebSocket host; the one-shot pipeline uses the
Token Plan gateway. Both are constants in `functions/`.

### Live client states

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Connecting: Start
  Connecting --> Active: WebSocket open, capture and playback ready
  Active --> Listening: ready
  Listening --> Thinking: response.created
  Thinking --> Speaking: first audio delta
  Speaking --> Listening: response.done
  Listening --> Reconnecting: socket closed
  Thinking --> Reconnecting: socket closed
  Speaking --> Reconnecting: socket closed
  Reconnecting --> Active: retry succeeds
  Reconnecting --> Idle: three failed retries
  Active --> Idle: Stop
  Listening --> Connecting: target language changed
  Thinking --> Connecting: target language changed
  Speaking --> Connecting: target language changed
```

- `Connecting` covers microphone permission, AudioContext resume, worklet load and
  the WebSocket handshake.
- `Reconnecting` retries after 1 s, 2 s and 4 s, then stops with an error.
- A fatal server `error` frame stops the session immediately.
- A language change closes the socket, clears scheduled audio and reconnects with
  a new `target`.

### Relay states

```mermaid
stateDiagram-v2
  [*] --> Validating
  Validating --> Rejected: method / action / origin / target / key invalid
  Validating --> Upgrading: request valid
  Upgrading --> Connecting: client WebSocket 101
  Connecting --> Ready: upstream open + session.updated
  Connecting --> Closed: no transport or 10 s handshake timeout
  Ready --> Streaming: client audio frames
  Streaming --> Streaming: append frame, accumulate bytes
  Streaming --> Committed: client_commit and at least 12,000 bytes
  Committed --> Responding: response.create
  Streaming --> Queued: commit while a response is in flight
  Queued --> Responding: response.done then response.create
  Responding --> Streaming: response.done
  Ready --> Closed: client close / 10 min limit
  Streaming --> Closed: client close / upstream error / oversized frame
  Responding --> Closed: upstream error / upstream close
  Closed --> [*]
```

Only one `response.create` is in flight at a time. A commit received while the
model is still answering sets `pendingResponse`; the relay sends the next
`response.create` immediately after `response.done`, so a second phrase is queued
rather than lost.

## Call flows

### Page load and key state

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant P as app.js / realtime.js
  participant F as Edge Function /key

  B->>P: load page
  P->>F: GET /functions/v1/app/key
  alt DASHSCOPE_API_KEY set in function environment
    F-->>P: configured true, source server
    P->>P: Settings shows "Managed by this site", enable Start
  else st_key cookie present
    F-->>P: configured true, source browser
    P->>P: Settings shows "Saved in this browser"
  else no key
    F-->>P: configured false, source none
    P->>P: Settings shows "Not set" with the key form, disable Start
  end
  B->>P: open Settings, paste key, Save
  P->>F: POST /key with apiKey
  F->>F: validate KEY_PATTERN
  F-->>P: Set-Cookie st_key HttpOnly, SameSite=Strict
  P->>P: update Settings state and page controls
```

The key never reaches localStorage or page HTML. `DELETE /key` expires the cookie;
a server-side environment key remains in use.

### One-shot translation

```mermaid
sequenceDiagram
  autonumber
  participant U as Speaker
  participant P as app.js
  participant F as Edge Function
  participant A as ASR model
  participant L as Translation model
  participant T as TTS model

  U->>P: Start recording
  P->>P: MediaRecorder, max 120 s
  U->>P: Stop and translate
  P->>P: decode, downmix, resample to 16 kHz, encode WAV
  P->>F: POST /asr audioBase64
  F->>F: validate JSON, base64, RIFF/WAVE header, size
  F->>A: multimodal-generation generation
  A-->>F: transcript
  F-->>P: text and milliseconds
  P->>F: POST /translate text and target
  F->>F: validate text length and target language
  F->>L: chat/completions, temperature 0.1
  L-->>F: translated text
  F-->>P: text, milliseconds, model
  P->>F: POST /tts text and target
  F->>T: SpeechSynthesizer
  T-->>F: audio bytes or URL
  F->>F: accept direct audio or download URL, cap at 8 MiB
  F-->>P: audioBase64, mime, milliseconds
  P->>U: render transcript and translation, play audio
```

### Live session setup

```mermaid
sequenceDiagram
  autonumber
  participant P as realtime.js
  participant F as Edge Function
  participant R as Relay
  participant M as Realtime model

  P->>P: getUserMedia, AudioContext resume, worklet load
  P->>F: WSS /functions/v1/app?action=realtime&target=es
  F->>R: handleRealtimeUpgrade
  R->>R: check GET, action, Origin, target, key
  alt invalid
    R-->>P: HTTP error with code
  else valid
    R-->>P: 101 Switching Protocols
    R->>M: connect realtime endpoint with model
    Note over R: constructor, then fetch upgrade, then raw TLS
    M-->>R: session.created
    R->>M: session.update
    Note over R: instructions, voice longanqian, pcm, turn_detection null
    M-->>R: session.updated
    R-->>P: ready with model and voice
    R-->>P: state listening
    P->>P: enable microphone frames
  end
```

The client opens the socket only after capture and playback contexts are running.
The relay starts a 10 s handshake timer and a 10-minute session timer; the client
sends `keepalive` every 20 s.

### Live turn with manual VAD

```mermaid
sequenceDiagram
  autonumber
  participant U as Speaker
  participant W as pcm-worklet
  participant P as realtime.js
  participant R as Relay
  participant M as Realtime model

  U->>W: speech
  loop every 100 ms
    W->>P: frame, 1600 samples at 16 kHz
    P->>R: binary PCM16
    R->>M: input_audio_buffer.append
  end
  loop every 300 ms
    W->>P: level, peak 0 to 1
  end

  Note over P: voice starts at level 0.02 or higher
  Note over P: after at least 300 ms of speech and 2 quiet windows
  P->>R: client_commit
  R->>R: require at least 12,000 uncommitted bytes
  R->>M: input_audio_buffer.commit
  alt no response in flight
    R->>M: response.create
  else response in flight
    R->>R: set pendingResponse
    Note over R: send response.create after response.done
  end

  M-->>R: response.created
  R-->>P: state thinking
  M-->>R: response.audio_transcript.delta
  R-->>P: caption delta
  M-->>R: response.audio.delta, base64 PCM16
  R-->>P: binary PCM16 at 24 kHz
  P->>P: schedule on AudioContext
  M-->>R: response.done
  R-->>P: turn with text and latency
  R-->>P: state listening
  P->>R: client_timing
  P->>R: client_turn_end
```

### Playback scheduling

```mermaid
flowchart TD
  chunk["Binary PCM16 chunk<br/>24 kHz mono"] --> peak["Measure peak"]
  peak --> idle{"Queue empty?"}
  idle -- yes --> start["Start 20 ms from now"]
  idle -- no --> policy{"decidePlayback"}
  start --> policy
  policy --> lead{"awaiting first audible chunk<br/>and peak below 300<br/>and trimmed under 1500 ms?"}
  lead -- yes --> skipLead["Skip lead silence<br/>add to skippedLeadMs"]
  lead -- no --> silent{"peak below 300<br/>and queued over 0.35 s?"}
  silent -- yes --> skipSilence["Drop silent padding"]
  silent -- no --> rate{"queued 0.6 s or less?"}
  rate -- yes --> normal["Play at 1.0x"]
  rate -- no --> faster["Play at 1.0x to 1.4x<br/>based on backlog"]
  normal --> schedule["Create buffer source<br/>schedule at nextStart"]
  faster --> schedule
  schedule --> meter["Flash output meter"]
  schedule --> timing["Send client_timing once per turn"]
```

`web/playback-policy.js` is a pure function so the policy can be tested without a
browser. The scheduler keeps a monotonic `nextStart` in `AudioContext` time.

### Reconnect, language switch and stop

```mermaid
flowchart TD
  close["Socket closes unexpectedly"] --> idle{"Status idle?"}
  idle -- yes --> done["Do nothing"]
  idle -- no --> retry{"Attempt under 3?"}
  retry -- yes --> wait["Wait 1 s, 2 s or 4 s"]
  wait --> reconnect["Reconnect to same target"]
  reconnect --> open{"Opened and ready?"}
  open -- yes --> resume["Listening, counter reset"]
  open -- no --> retry
  retry -- no --> giveUp["Stop session<br/>show retry error"]

  change["Target language changed"] --> closeNow["Close socket, clear playback"]
  closeNow --> connectNow["Connect immediately with new target"]

  userStop["Stop pressed"] --> teardown["Stop tracks, close contexts,<br/>close socket, clear UI"]
```

## Repository layout

| Path | Role |
| --- | --- |
| `web/` | Static pages, capture worklet, playback policy, Settings dialog, styles |
| `functions/` | Deno Edge Function: HTTP routes plus the realtime relay |
| `dev/` | Local preview server, mock realtime socket, tests |
| `docs/` | Detailed architecture and call-flow reference |

[docs/architecture.md](docs/architecture.md) adds file responsibilities, security
boundaries, limits, design decisions and observability.
[docs/call-flows.md](docs/call-flows.md) adds the WebSocket protocol tables,
latency budget, failure handling and verification commands.

## Local development

Requires Node.js 24+ (the dev server imports the TypeScript function directly).

```bash
cd speech-site
node dev/server.mjs
# http://127.0.0.1:4173/           one-shot page
# http://127.0.0.1:4173/realtime.html  live interpreter
```

The server loads `DASHSCOPE_API_KEY` from
`speech-translator/.streamlit/secrets.toml` without printing it. Useful
environment variables:

| Variable | Effect |
| --- | --- |
| `PORT` | Preview port, default `4173` |
| `SKIP_KEY_FILE` | Set to `1` to ignore the local secrets file |
| `MOCK_REALTIME` | Set to `1` to serve the mock live socket |
| `DASHSCOPE_API_KEY` | Use this key instead of the local secrets file |

The realtime pages require a secure context for microphone access. Use
`localhost`/`127.0.0.1`, or the deployed HTTPS site.

## Tests

```bash
node --test dev/test-realtime-map.mjs \
  dev/test-realtime-validate.mjs \
  dev/test-playback-policy.mjs \
  dev/test-raw-ws.mjs \
  dev/test-settings-state.mjs \
  dev/test-realtime-upstream.mjs \
  dev/test-auth-failure.mjs
```

These cover upstream event projection, upgrade validation, playback policy, the
raw RFC 6455 framing fallback, the Settings key-state view, upstream failure
classification and the key-rejection message shown in the browser. `dev/verify-handler.mjs` exercises the real
ASR → translation → TTS pipeline against a local WAV sample and a configured key.

## Configuration and secrets

- Never commit API keys, `.env` files or Streamlit secrets. `.env*` and
  `*.qoder.site` are already gitignored at the repository root.
- Server-side key: set `DASHSCOPE_API_KEY` in the Qoder Sites function
  environment / Sites Settings. The Settings dialog then reports the key as
  managed by the site and hides the form.
- Browser key: pasting a key in the Settings dialog posts it once to `/key`, which stores it
  in the HttpOnly `st_key` cookie (`Path=/functions/v1/app`,
  `SameSite=Strict`, `Secure` on HTTPS). It is never put in localStorage or the
  published JavaScript.
- Key family: one-shot mode accepts a Model Studio Token Plan key (`sk-sp`). The
  live interpreter must use a workspace key (`sk-ws`); the realtime host rejects
  Token Plan keys. `/key` reports the stored family, the Settings dialog states
  which key the page needs, and the live page refuses an `sk-sp` key before
  saving it. A Token Plan key saved earlier warns immediately on the live page,
  and an auth rejection names the family the relay actually sent.
- The site remains private. Publishing a new build does not change its audience.

## Deployment

The site is published from this directory through Qoder Sites. The local
`.Speech Translator.qoder.site` descriptor is created and updated by the Sites
tooling and is gitignored — do not commit or hand-edit it.

Before publishing, validate the static files and the function locally, then
prepare and publish through the Sites workflow.
# speed-translate
