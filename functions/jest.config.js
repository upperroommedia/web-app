module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: {
    '^@upperroom/shared/(.*)$': '<rootDir>/../packages/shared/$1',
    '^@upperroom/contracts/(.*)$': '<rootDir>/../packages/contracts/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  testTimeout: Number(process.env.JEST_TEST_TIMEOUT_MS || 180000), // Emulator-backed suites need a higher default.
  maxWorkers: 1, // Run tests serially to avoid Firestore emulator interference between parallel tests
  // Silence console output by default unless VERBOSE is set
  silent: !process.env.VERBOSE,
  verbose: !!process.env.VERBOSE,
};
