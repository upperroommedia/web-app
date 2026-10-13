const path = require('node:path');
module.exports = {
  ...require('../../jest.config.cjs'),
  rootDir: path.resolve(__dirname, '../..'),
  testMatch: ['<rootDir>/src/integration/*.test.ts'],
  testPathIgnorePatterns: [],
  setupFiles: [path.resolve(__dirname, './setup.cjs')],
  moduleNameMapper: {
    '^@upperroom/shared/(.*)$': path.resolve(__dirname, '../../../../packages/shared/$1'),
    '^@upperroom/contracts/(.*)$': path.resolve(__dirname, '../../../../packages/contracts/$1'),
    '^@upperroom/orchestration/(.*)$': path.resolve(__dirname, '../../../../packages/orchestration/src/$1'),
  },
  testTimeout: 240000,
};
