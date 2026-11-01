import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite does real file and network-shaped work, and it runs in
    // parallel. On a busy machine five seconds is not always enough for a
    // file to be written and read back.
    testTimeout: 20000,
  },
})
