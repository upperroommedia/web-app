/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['./test/jest.setup.ts'],
  transform: {
    '^.+.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
      },
    ],
  },
};
