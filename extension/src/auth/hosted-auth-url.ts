/**
 * Hosted auth base URL.
 * Vite replaces __VERTEX_HOSTED_AUTH_URL__ at build time (see vite.config.mjs).
 * process.env is kept as a runtime override for local debugging.
 */
declare const __VERTEX_HOSTED_AUTH_URL__: string | undefined;

const DEFAULT_HOSTED_AUTH_URL = 'https://auth-for-vertex-swarm.onrender.com';

export function getHostedAuthUrl(): string {
  const fromDefine =
    typeof __VERTEX_HOSTED_AUTH_URL__ !== 'undefined' ? __VERTEX_HOSTED_AUTH_URL__ : undefined;
  const configured =
    process.env.VERTEX_HOSTED_AUTH_URL || fromDefine || DEFAULT_HOSTED_AUTH_URL;
  return configured.replace(/\/$/, '');
}
