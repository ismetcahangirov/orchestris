// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.codegraph/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'apps/web/vitest.config.ts',
            'apps/server/drizzle.config.ts',
            'scripts/fetch-models-snapshot.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Task-a xas heç nə server prosesindən qopa bilməz — unudulmuş `await`
      // yoxlamanı sükutla keçib gedən icraya çevirir (bax CLAUDE.md qayda 3).
      // `void expr()` naxışı qəsdəndir və bu qayda tərəfindən icazəlidir.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // apps/web server-in daxili tətbiq detallarından (spawn, DB, runner-lər)
      // asılı olmamalıdır — yalnız @orchestris/shared üzərindən danışır.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@orchestris/server', '@orchestris/server/*'],
              message: 'apps/web yalnız @orchestris/shared üzərindən server ilə danışmalıdır.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // `scripts/` altındakı köməkçi skriptlər tsconfig-ə daxil deyil (repo
    // koduna girmirlər), ona görə Node qlobalları əl ilə elan olunur.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { fetch: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
)
