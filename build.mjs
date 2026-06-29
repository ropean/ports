#!/usr/bin/env node
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  // Keep native Node built-ins external; bundle third-party deps
  packages: 'bundle',
});

import { chmodSync } from 'fs';
chmodSync('dist/index.js', 0o755);

console.log('Build complete → dist/index.js');
