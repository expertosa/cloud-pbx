import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/cloudpbx',
      JWT_SECRET: 'test-jwt-secret',
      ARI_PASSWORD: 'test-ari-password',
      AI_RECEPTIONIST_ENABLED: 'false',
    },
  },
});
