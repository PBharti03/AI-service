import js from "@eslint/js";
import { defineConfig } from "eslint/config";

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  ReadableStream: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  console: "readonly",
  clearTimeout: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  performance: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
};

export default defineConfig(
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: nodeGlobals },
    rules: {
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
    },
  },
);
