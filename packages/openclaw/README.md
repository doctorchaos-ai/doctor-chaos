# @doctorchaos-ai/openclaw

> **Alpha.** Doctor Chaos as an [OpenClaw](https://github.com/openclaw/openclaw) context engine.

Routes each turn to its **topic space** and assembles that space's history as the model context — instead of feeding the whole linear transcript. In-process wrapper around [`@doctorchaos-ai/core`](https://github.com/doctorchaos-ai/doctor-chaos) (no daemon, no extra process).

## Install (local, for dogfooding)

```bash
# from a built checkout of this package
openclaw plugins install -l /path/to/doctor-chaos/packages/openclaw
```

Then in `openclaw.json`:

```json5
{
  plugins: {
    slots: { contextEngine: "doctor-chaos" }
  }
}
```

Restart the gateway.

## Note on the engine slot

OpenClaw activates **one** context engine at a time. Selecting `doctor-chaos`
replaces `legacy` (the default) or `lossless-claw` for that agent. Doctor Chaos
specializes in **topic routing**, which is a different concern from
lossless-claw's lossless compaction — they are not run together in v0.1.

## Status

Early alpha — the engine currently loads and runs as a safe pass-through while
topic routing is wired in. Follow https://github.com/doctorchaos-ai/doctor-chaos.
