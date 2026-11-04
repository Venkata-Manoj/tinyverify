import { handleRequest } from '../lib/router.js';

/**
 * Vercel Node function. Every /api/* request is rewritten here by Vercel's
 * filesystem routing; public/ is served as static assets by the platform.
 * No build step, no framework, no dependencies.
 */
export default async function handler(req, res) {
  await handleRequest(req, res);
}

export const config = {
  maxDuration: 300,
};
