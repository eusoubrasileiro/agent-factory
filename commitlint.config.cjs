module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "bug",
        "hotfix",
        "chore",
        "docs",
        "refactor",
        "test",
        "style",
        "perf",
        "ci",
        "build",
        "revert",
      ],
    ],
  },
};
