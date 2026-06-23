# @doctorchaos-ai/openclaw

> **Alpha.** Doctor Chaos as an [OpenClaw](https://github.com/openclaw/openclaw) context engine.

Routes each turn to its **topic space** and assembles that space's history as the model context — instead of feeding the whole linear transcript. In-process wrapper around [`@doctorchaos-ai/core`](https://github.com/doctorchaos-ai/doctor-chaos) (no daemon, no extra process).

## Install (local, for dogfooding)

Build, pack a tarball (clean — no `node_modules`, so OpenClaw's supply-chain
scanner has nothing to flag and you don't need to touch `security.installPolicy`),
then install the tarball:

```bash
cd /path/to/doctor-chaos/packages/openclaw
pnpm install && pnpm build
pnpm pack                      # → doctorchaos-ai-openclaw-<version>.tgz (dist + manifest only)
openclaw plugins install <that .tgz>   # exact subcommand/flag: see `openclaw plugins --help`
```

> `@doctorchaos-ai/core` is bundled into the plugin's `dist`, so the tarball is
> self-contained — no separate core install. Avoid `--link`/`-l` on the source
> dir: it drags pnpm's `node_modules` symlinks into the install and trips the
> security scanner.

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

Early alpha. The engine loads and runs on real OpenClaw (verified). v0.1 wiring:
- `ingest` routes each message into its topic space (`@doctorchaos-ai/core`).
- `assemble` selects the relevant topic space and returns its history (trimmed
  to the token budget); safely passes through the host's context before topics
  form or on any error (no-worse-than-default).
- `compact` is a no-op (Doctor Chaos bounds context via topic assembly).
- `afterTurn` runs opportunistic packaging/lifecycle maintenance + persistence.

LLM-assisted routing (via the host's `runtimeContext.llm`) is a fast-follow.
Follow https://github.com/doctorchaos-ai/doctor-chaos.
