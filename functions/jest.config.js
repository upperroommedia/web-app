module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  testTimeout: 30000, // Increase timeout for emulator tests
  maxWorkers: 1, // Run tests serially to avoid Firestore emulator interference between parallel tests
  // Silence console output by default unless VERBOSE is set
  silent: !process.env.VERBOSE,
  verbose: !!process.env.VERBOSE,
};


