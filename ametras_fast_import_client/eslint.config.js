import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

export default tseslint.config(
  { ignores: [
    'dist/', 'dist-electron/', 'release/', 'coverage/', 'node_modules/',
    'electron/**/*.js', 'electron/**/*.d.ts',  // compiled output from .ts
    'vite.config.js',                           // compiled output from .ts
    'electron/preload.cjs',                     // CommonJS bridge, not lintable as ESM
  ] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Vue template formatting — match project style (compact, 2-space indent)
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': ['warn', {
        html: { void: 'any', normal: 'any', component: 'always' },
      }],
      'vue/html-indent': ['warn', 2],

      // TypeScript
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // General
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // Electron main/preload process — Node.js environment
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
