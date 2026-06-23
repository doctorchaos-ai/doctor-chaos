import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  // The OpenClaw plugin SDK is provided by the host runtime (external).
  // @doctorchaos-ai/core is bundled INTO the plugin (noExternal) so the
  // packed/installed plugin is self-contained — no separate core install.
  external: [/^openclaw(\/|$)/],
  noExternal: ['@doctorchaos-ai/core'],
});
