// ESLint 9 flat config for the smart-mcps monorepo.
// Single root config covers every workspace under packages/*.
// Type-aware rules are intentionally disabled — recommended-type-checked
// is too slow and noisy across a multi-project workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores. Must be in its own object with ONLY `ignores` to act globally.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "**/vitest.config.ts",
      "**/eslint.config.js",
    ],
  },

  // Base JS recommended.
  js.configs.recommended,

  // TypeScript recommended (non-type-aware).
  ...tseslint.configs.recommended,

  // Repo-wide rule tuning for source files.
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Allow underscore-prefixed unused vars/args. Matches our convention
      // for intentionally-ignored callback params.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Tests + fixtures: relax rules that fight pragmatic test code.
  {
    files: ["packages/*/src/**/__tests__/**/*.ts", "packages/*/src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
