module.exports = {
  preset: 'ts-jest',
  // Admin14 uses jose ESM; preserve the Node22 test target by transforming only that dependency.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
    '^.+\\.[cm]?js$': [
      'babel-jest',
      { babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?jose(?:/|$))'],
  testEnvironment: 'node',
  // Annotate failed suites as they finish instead of waiting for the final summary.
  reporters: process.env.GITHUB_ACTIONS === 'true' ? [['github-actions', { silent: false }], 'summary'] : ['default'],
  setupFiles: ['<rootDir>/../scripts/firebase-test-isolation.cjs'],
  testMatch: ['**/*.test.ts'],
  roots: ['<rootDir>/src', '<rootDir>/../packages/orchestration/src'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: {
    '^@upperroom/shared/(.*)$': '<rootDir>/../packages/shared/$1',
    '^@upperroom/orchestration/(.*)$': '<rootDir>/../packages/orchestration/src/$1',
    '^@upperroom/contracts/(.*)$': '<rootDir>/../packages/contracts/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  testTimeout: Number(process.env.JEST_TEST_TIMEOUT_MS || 180000), // Emulator-backed suites need a higher default.
  maxWorkers: 1, // Run tests serially to avoid Firestore emulator interference between parallel tests
  // Recycle the single worker between suites instead of retaining every Node22 VM/module context.
  // Full-suite commands must omit --runInBand, which disables worker recycling.
  workerIdleMemoryLimit: '1024MiB',
  // Silence console output by default unless VERBOSE is set
  silent: !process.env.VERBOSE,
  verbose: !!process.env.VERBOSE,
};
