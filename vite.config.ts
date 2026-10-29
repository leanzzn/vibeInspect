import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createAiMiddleware, describeConfig, readConfig } from './server/ai';

// CHATKHU_* 값은 이 Node 프로세스(서버)에서만 읽는다.
// 브라우저 번들에는 VITE_ 로 시작하는 변수만 들어가므로 키가 포함되지 않는다(envPrefix를 바꾸지 말 것).
function ai(mode: string): Plugin {
  const cfg = readConfig({ ...loadEnv(mode, process.cwd(), 'CHATKHU_') });
  const mount = (s: { middlewares: { use: (fn: ReturnType<typeof createAiMiddleware>) => void } }) => {
    console.info(describeConfig(cfg));
    s.middlewares.use(createAiMiddleware(cfg));
  };
  return { name: 'vibeinspect-ai', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ai(mode)],
  // 다른 로컬 프로젝트(기본 5173)와 겹치지 않게 고정 포트, 로컬에서만 접근
  server: { host: 'localhost', port: 5180, strictPort: true },
  preview: { host: 'localhost', port: 4180, strictPort: true },
  test: { include: ['src/**/*.test.ts'] },
}));
