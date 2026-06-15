import { defineConfig } from 'vitest/config';

// Client tests run in Node: the controllers under test pull in only the
// deterministic sim (no DOM), and their Net/Clock/Keyboard deps are typed-only
// imports we stub. Keeps these out of the build (vite uses index.html) and out
// of `tsc` (tsconfig includes only src).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
