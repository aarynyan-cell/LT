// 同时启动模拟 API 与应用（无需任何密钥）：npm run dev:mock
import { startMock } from './mock-api.mjs';

const port = Number(process.env.MOCK_PORT || 8788);
await startMock(port);
process.env.ANTHROPIC_API_KEY ||= 'mock-key';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.GOOGLE_TRANSLATE_API_KEY ||= 'mock-key';
process.env.GOOGLE_TRANSLATE_ENDPOINT = `http://127.0.0.1:${port}/language/translate/v2`;
console.log(`[dev-mock] 使用模拟 Claude/Google（端口 ${port}），输出为占位内容`);
await import('../server.js');
