// Cloudflare Worker 入口：只有 /relay 会进入 Worker（见 wrangler.jsonc 的 run_worker_first），其余静态资源直接由平台提供。
import { handleRelay } from './relay.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/relay') return handleRelay(request, { extraHosts: env.RELAY_EXTRA_HOSTS || '' });
    return env.ASSETS.fetch(request);
  },
};
