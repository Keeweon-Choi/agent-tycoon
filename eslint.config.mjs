import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import agentTycoonPlugin from './eslint-rules/agent-tycoon-rules.mjs';

export default [
  {
    files: ['**/*.ts'],
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
      'simple-import-sort': simpleImportSort,
      'agent-tycoon': agentTycoonPlugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      curly: 'error',
      eqeqeq: 'error',
      'no-throw-literal': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'agent-tycoon/no-inline-colors': 'error',
    },
  },
  eslintConfigPrettier,
];
