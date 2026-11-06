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
  // Project Brain K0 (cld/docs/design/project-brain.md §5): the spec module does not lean on the
  // engine and the engine does not reach into spec/. Shared shapes live in core/src/cld/spec.
  {
    files: ['server/src/cld/spec/**/*.ts'],
    ignores: ['**/*.test.ts', '**/__fixtures__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Allowed: this folder, core/, and the daemon tools below (engine/git/* and
              // engine/registry are tool files that live under engine/, not engine logic;
              // shell/gate is the step-up refusal word).
              regex:
                '^(?!\\./)(?!(?:\\.\\./){4}core/)(?!\\.\\./\\.\\./constants\\.js$)(?!\\.\\./(?:mask|jsonFile|audit|authRoutes|configPath|files/roots|files/security|tracking/docs|tracking/settings|engine/git/gitRun|engine/git/repoRead|engine/registry|shell/gate)\\.js$)\\.',
              message:
                'spec/ may import only itself, core/ and the daemon tools listed in eslint.config.mjs (BRN K0). Move the shape to core/src/cld/spec or inject it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['server/src/cld/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:\\.\\./)+spec/',
              message: 'The engine does not import spec/ (BRN K0). Use the shared shapes in core/src/cld/spec/trace.ts.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
];
