import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      name: 'VertexSwarmExtension',
      fileName: () => 'extension.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['vscode', 'http', 'path', 'fs', 'child_process', 'node:child_process'],
      output: {
        globals: {
          vscode: 'vscode',
        },
      },
    },
    outDir: './dist',
    emptyOutDir: true,
  },
});