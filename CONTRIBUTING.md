# Contributing to Coltivio API

Thank you for your interest in contributing! Coltivio is a nonprofit open-source farm management platform.

## Getting started

1. Fork the repository
2. Follow the setup instructions in [README.md](README.md)
3. Create a feature branch from `main`

## Development workflow

```bash
yarn start              # start dev server
yarn test               # run all tests
npx tsc --noEmit        # typecheck
yarn lint               # lint and auto-fix unused imports
yarn format             # auto-format with Prettier
```

## Submitting changes

Before opening a PR, make sure all of the following pass locally:

```bash
npx tsc --noEmit
npx prettier --check "src/**/*.ts"
yarn lint
yarn test
```

These same checks run automatically in CI on every push and pull request.

1. Write tests for new features or bug fixes
2. Open a pull request against `main` — don't worry about commit history, we squash merge

## Code style

- TypeScript strict mode, no `any` types
- Zod schemas for all API input/output validation
- All database queries go through the RLS-aware connection (`rlsDb.rls()`)
- Use Drizzle's parameterized queries — never use `sql.raw()` with user input
- Unused imports are enforced by ESLint — prefix intentionally unused variables/args with `_`

## Reporting issues

Open an issue on GitHub. For security vulnerabilities, please email the maintainers directly instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the same [Commons Clause + AGPL-3.0 license](LICENSE) as the project.
