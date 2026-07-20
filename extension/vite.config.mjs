import { defineConfig, loadEnv } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const hostedAuthUrl =
    env.VERTEX_HOSTED_AUTH_URL || 'https://auth-for-vertex-swarm.onrender.com';

  return {
    define: {
      // Vite 8 does not reliably rewrite process.env.* in lib builds.
      // Use an explicit global that we control in source.
      __VERTEX_HOSTED_AUTH_URL__: JSON.stringify(hostedAuthUrl),
      'process.env.VERTEX_HOSTED_AUTH_URL': JSON.stringify(hostedAuthUrl),
    },
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
  };
});