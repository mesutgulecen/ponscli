import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const TYPED_FILES = ['src/**/*.ts', 'test/**/*.ts', '*.config.ts']

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  {
    files: TYPED_FILES,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Bare `console` is the CLI's output channel; the output layer owns it.
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    // Build scripts are plain ESM outside the TypeScript project, so they get
    // the untyped ruleset rather than being excluded from linting entirely.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-console': 'off' },
  },
)
