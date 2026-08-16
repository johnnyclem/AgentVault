import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // dist-cli/ and test-build/ are compiled copies of src/ and cli/; without
      // excluding them the same code is counted twice.
      exclude: ['node_modules/', 'dist/', 'dist-cli/', 'test-build/', 'tests/'],
    },
  },
});
