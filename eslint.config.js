import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'

export default [
  // Global ignores
  {
    ignores: ['dist/', 'dist-electron/', 'release/', 'node_modules/', '**/*.cjs'],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended (no type-checked — tsconfig strict already covers that)
  ...tseslint.configs.recommended,

  // Vue recommended (flat config)
  ...pluginVue.configs['flat/recommended'],

  // Vue SFC parsing
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
  },

  // Browser globals for src/
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Node globals for electron/ and tests/
  {
    files: ['electron/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Shared rule overrides
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'vue/multi-word-component-names': 'off',
      // Formatting rules — project does not use an auto-formatter
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/attributes-order': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },

  // Electron preload requires CommonJS require()
  {
    files: ['electron/preload.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Test-specific relaxations
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-expressions': 'off',
    },
  },
]
