# Ametras Fast Import Documentation

High-performance CSV import tool for Odoo, available as an embedded Odoo client action and a standalone Electron desktop application.

## Key Capabilities

- **Scalability**: Streams files larger than 1GB with constant memory usage
- **Performance**: Parallel workers (up to 4 addon, 3 standalone) with concurrency retry
- **Reliability**: Per-row savepoints (addon) or geometric retry splitting (standalone)
- **Network Resilience**: Auto-pause, exponential backoff health checks, seamless resume
- **Intelligence**: Smart model and field mapping suggestions based on filenames and headers
- **Repeatability**: Import Profiles bundle multi-file configurations as reusable ZIPs

## Documentation

| Document | Contents |
|----------|----------|
| [Quickstart](quickstart.md) | Connection, file management, basic workflow |
| [Profiles & Mapping](profiles.md) | Profiles, field mapping, transforms, import strategies |
| [Settings](settings.md) | Run settings, CSV parser, standalone constraints |
| [Running Imports](import-run.md) | Execution flow, monitoring, results, error handling |
| [Standalone Mode](standalone.md) | Detection, feature comparison, concurrency retry, limitations |

### Developer Guide

- [Architecture](developer-guide/architecture.md) — Package structure, network resilience, embedded mode
- [Odoo Backend](developer-guide/odoo-backend.md) — API endpoints, data models, cron jobs
- [Testing](developer-guide/testing.md) — Unit tests, E2E tests, Python tests
- [Extending](developer-guide/extending.md) — Adding new features
