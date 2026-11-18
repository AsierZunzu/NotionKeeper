import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Mirrors the rules previously enforced by Checkstyle
export default defineConfig(
  { ignores: ['node_modules/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'curly': 'error',
      'eqeqeq': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-fallthrough': 'error',
      'default-case-last': 'error',
      'max-statements-per-line': 'error',
      'no-unneeded-ternary': 'error',
      'no-extra-boolean-cast': 'error',
      'eol-last': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
      ],
    },
  },
);
