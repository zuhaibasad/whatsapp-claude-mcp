import tseslint from 'typescript-eslint';

// Read-only rule, layer 1: only src/daemon/wa/** may import the WhatsApp library.
const WA_LIB = ['baileys', '@whiskeysockets/baileys', 'whatsapp-web.js'];

export default tseslint.config(
  { ignores: ['build/**', 'dist/**', 'node_modules/**', 'coverage/**', '.wa-bridge/**', '.agents/**', '.claude/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: WA_LIB.map((name) => ({ name, message: 'Only src/daemon/wa/** may import the WhatsApp library (read-only guard).' })),
        patterns: [{ group: WA_LIB.map((n) => `${n}/*`), message: 'Only src/daemon/wa/** may import the WhatsApp library (read-only guard).' }],
      }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The WhatsApp adapter folder, and tests that mock the library.
    files: ['src/daemon/wa/**/*.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
