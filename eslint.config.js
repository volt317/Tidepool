// Flat ESLint config: typescript-eslint recommended across server, shared, and
// web, plus react-hooks rules for the console. `npm run lint` must be clean.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".cache/**", "server/lib/**", "server/sources/**", "server/index.js"] },
  ...tseslint.configs.recommended,
  {
    files: ["server/src/**/*.ts", "server/test/**/*.ts", "shared/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off"
    }
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
