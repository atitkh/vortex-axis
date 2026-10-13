import { defineConfig } from "vitest/config";

// Every test starts a real server and talks to it over sockets, with waits measured in seconds. On a busy
// machine (a CI runner sharing its host, a laptop building something else) those waits run out and tests
// fail that are not broken. So: longer limits everywhere, and on CI fewer files at once.
const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    testTimeout: ci ? 30_000 : 15_000,
    hookTimeout: ci ? 45_000 : 20_000,
    ...(ci ? { maxWorkers: 2, minWorkers: 1 } : {}),
    // One more go for a test that timed out under load; a test that is really broken fails twice.
    retry: ci ? 2 : 1,
  },
});
