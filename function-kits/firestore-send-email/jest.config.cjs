module.exports = { watchman: false, testEnvironment: "node", testMatch: ["**/test/**/*.test.ts"], transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] } };
