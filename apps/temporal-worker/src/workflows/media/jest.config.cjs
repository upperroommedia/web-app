module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  setupFiles: [require('node:path').resolve(__dirname, './resource-test-environment.cjs')],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@upperroom/orchestration/(.*)$': require('node:path').resolve(
      __dirname,
      '../../../../../packages/orchestration/src/$1'
    ),
    '^@upperroom/contracts/(.*)$': require('node:path').resolve(__dirname, '../../../../../packages/contracts/$1'),
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true },
        diagnostics: true,
      },
    ],
  },
};
