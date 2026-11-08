// Infrastructure-free runner. Deliberately independent of package.json's Jest setup.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/animals/*.unit.test.ts"],
};
