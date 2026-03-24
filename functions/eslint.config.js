const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const _import = require("eslint-plugin-import");
const js = require("@eslint/js");

module.exports = [
    js.configs.recommended,
    // Configuration for JavaScript files
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            import: _import,
        },
        rules: {
            "import/no-unresolved": 0,
            "prettier/prettier": "off",
        },
    },
    // Configuration for TypeScript files
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest,
            },
            parser: tsParser,
            parserOptions: {
                tsconfigRootDir: __dirname,
                project: ["tsconfig.json", "tsconfig.dev.json"],
            },
        },
        plugins: {
            "@typescript-eslint": typescriptEslint,
            import: _import,
        },
        rules: {
            ...typescriptEslint.configs.recommended.rules,
            "import/no-unresolved": 0,
            "prettier/prettier": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    {
        ignores: ["lib/**/*"],
    },
];
