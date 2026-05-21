import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  external: ['@doctorchaos-ai/core'],
  // CLI entry needs the shebang so it can be invoked as `doctor-chaos-server`
  // after npm install -g. tsup drops shebangs from source files through the
  // bundler, so we re-inject it via the banner for just the CLI build.
  banner: (ctx) => {
    if (ctx.format === 'cjs') {
      return { js: '#!/usr/bin/env node' };
    }
    return {};
  },
});
