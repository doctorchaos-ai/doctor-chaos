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
  // core is resolved in-process at runtime; the OpenClaw plugin SDK is
  // provided by the host runtime. Neither is bundled into the plugin.
  external: ['@doctorchaos-ai/core', /^openclaw(\/|$)/],
});
