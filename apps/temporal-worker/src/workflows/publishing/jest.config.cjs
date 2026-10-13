module.exports = {
  rootDir: '../../../..',
  testEnvironment: 'node',
  testMatch: ['**/workflows/publishing/publishing.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true },
        diagnostics: false,
      },
    ],
  },
  testTimeout: 120000,
  maxWorkers: 1,
};
