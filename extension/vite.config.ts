import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      name: 'VertexSwarmExtension',
      fileName: () => 'extension.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['vscode', 'http', 'path', 'fs'],
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
