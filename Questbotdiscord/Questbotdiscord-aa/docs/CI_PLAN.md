# CI Plan

The workflow file could not be added automatically by the connector in this session.

Recommended checks for the first CI workflow:

- Install pnpm dependencies
- Run translation validation
- Run unit tests
- Run the optional fixture checker
- Run the frontend build
- Run Rust cargo checks later after the source import is confirmed stable

Keep the first workflow small. Add packaging and release jobs only after normal checks are green.
