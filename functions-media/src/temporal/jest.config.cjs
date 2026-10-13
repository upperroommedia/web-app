const path = require('node:path');
module.exports = {
  rootDir: __dirname,
  setupFiles: [path.resolve(__dirname, '../../../scripts/firebase-test-isolation.cjs')],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: { '^@upperroom/contracts/(.*)$': path.resolve(__dirname, '../../../packages/contracts/$1') },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true } },
    ],
  },
};
