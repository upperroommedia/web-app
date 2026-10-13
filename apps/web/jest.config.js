/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/../../scripts/firebase-test-isolation.cjs'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  modulePathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/.vercel/'],
};
