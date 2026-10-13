module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/../../scripts/firebase-test-isolation.cjs'],
  watchman: false,
  // Workspace builds emit adjacent JavaScript in shared packages. Tests must
  // keep selecting the current source, including workflow bundle entrypoints.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testPathIgnorePatterns: ['<rootDir>/src/integration/'],
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { ...require('./tsconfig.json').compilerOptions, isolatedModules: true } }],
    '^.+\\.[cm]?js$': [
      'babel-jest',
      { babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?jose(?:/|$))'],
};
