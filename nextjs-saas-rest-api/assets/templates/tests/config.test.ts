// src/config/api.test.ts (Vitest) — the config fails fast on bad environment values and applies overrides.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('apiConfig', () => {
  it('uses safe defaults when no variables are set', async () => {
    const { apiConfig } = await import('@/config/api');
    expect(apiConfig.pagination).toEqual({ defaultSize: 20, maxSize: 100 });
    expect(apiConfig.headers.security['Strict-Transport-Security']).toMatch(/^max-age=\d+; includeSubDomains$/);
  });

  it('applies valid overrides, including the origin allowlist', async () => {
    vi.stubEnv('API_PAGE_SIZE_MAX', '50');
    vi.stubEnv('API_ALLOWED_ORIGINS', 'https://app.example.com, https://admin.example.com');
    const { apiConfig } = await import('@/config/api');
    expect(apiConfig.pagination.maxSize).toBe(50);
    expect(apiConfig.origins.allowed).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('refuses to start with invalid values', async () => {
    vi.stubEnv('API_PAGE_SIZE_MAX', 'lots');
    await expect(import('@/config/api')).rejects.toThrow(/Invalid API configuration/);
    vi.resetModules();
    vi.stubEnv('API_PAGE_SIZE_MAX', '10');
    vi.stubEnv('API_PAGE_SIZE_DEFAULT', '25');
    await expect(import('@/config/api')).rejects.toThrow(/API_PAGE_SIZE_DEFAULT must not exceed/);
  });
});
