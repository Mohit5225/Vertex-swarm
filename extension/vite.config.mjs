import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    target: 'node18',
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      name: 'VertexSwarmExtension',
      fileName: () => 'extension.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        'vscode',
        'http', 'path', 'fs', 'child_process', 'crypto', 'os', 'fs/promises',
        'net', 'events',
        /node:.*/
      ],
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