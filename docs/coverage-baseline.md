# Test coverage

Run the V8 coverage suite with:

```bash
npm run test:coverage
```

Current baseline (Node.js 24.16.0, npm 11.13.0, Vitest 4.1.11):

- 23 test files and 204 passing tests
- Statements: 52.46% (2,146 of 4,090)
- Branches: 41.08% (1,368 of 3,330)
- Functions: 39.78% (444 of 1,116)
- Lines: 54.12% (2,041 of 3,771)

The measured scope is `src/**/*.{ts,tsx}` and `scripts/**/*.ts`. The separate
Playwright smoke test exercises the rendered dashboard end to end, but its
browser execution is not included in these Vitest percentages.

Server and contract boundary code has the strongest focused coverage. Remaining
gaps are concentrated in rendered UI composition, the process entry point, and
the interactive pivot and reporting views. CI enforces conservative floors
below this baseline to catch material regressions without rewarding
percentage-driven tests. New behavior should be covered at the narrowest useful
level, with the smoke test retained for cross-component workflows.
