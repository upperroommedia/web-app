import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@mui/*/*/*', '!@mui/material/test-utils/*'],
        },
      ],
      // React Compiler is not enabled yet. Keep its incremental adoption
      // diagnostics visible without blocking the existing Hooks checks.
      // https://react.dev/reference/eslint-plugin-react-hooks
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react/no-danger': 'off',
      'react/react-in-jsx-scope': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'react-hooks/exhaustive-deps': [
        'warn',
        {
          additionalHooks: '(useMyCustomHook|useMyOtherCustomHook)',
        },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    '.vercel/**',
    'out/**',
    'output/**',
    'build/**',
    'archivedPages/**',
    'functions/**',
    'functions-core/**',
    'functions-media/**',
    'functions-image/**',
    'functions-integrations/**',
    'next-env.d.ts',
  ]),
]);
