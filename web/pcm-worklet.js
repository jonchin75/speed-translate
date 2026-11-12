const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600;

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.position = 0;
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
    this.levelPeak = 0;
    this.framesSinceLevel = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let position = this.position;
    while (position < channel.length) {
      const index = Math.floor(position);
      const next = Math.min(index + 1, channel.length - 1);
      const mix = position - index;
      const sample = channel[index] * (1 - mix) + channel[next] * mix;

      this.frame[this.filled] = sample;
      this.filled += 1;
      const magnitude = Math.abs(sample);
      if (magnitude > this.levelPeak) this.levelPeak = magnitude;

      if (this.filled === FRAME_SAMPLES) {
        const pcm = new Int16Array(FRAME_SAMPLES);
        for (let i = 0; i < FRAME_SAMPLES; i += 1) {
          const value = Math.max(-1, Math.min(1, this.frame[i]));
          pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        this.port.postMessage({ type: "frame", buffer: pcm.buffer }, [pcm.buffer]);
        this.filled = 0;
        this.framesSinceLevel += 1;
        if (this.framesSinceLevel >= 3) {
          this.port.postMessage({ type: "level", value: this.levelPeak });
          this.levelPeak = 0;
          this.framesSinceLevel = 0;
        }
      }

      position += this.step;
    }

    this.position = position - channel.length;
    return true;
  }
}

registerProcessor("pcm-16k", Pcm16kProcessor);
