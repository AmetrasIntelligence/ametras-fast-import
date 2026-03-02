# CSV Import Tool Documentation

Welcome to the detailed documentation for the Ametras CSV Import Tool for Odoo.

## Overview

The CSV Import Tool is a high-performance desktop application designed to handle large-scale data imports into Odoo with precision and reliability. Unlike standard Odoo imports, this tool provides streaming processing, parallel execution, and sophisticated reference resolution.

### Key Capabilities

*   **Scalability**: Processes files larger than 1GB with constant memory usage through streaming.
*   **Performance**: Utilizes parallel workers (1-4) to maximize throughput while respecting Odoo's transactional integrity.
*   **Reliability**: Per-row savepoints ensure that one failed row doesn't roll back the entire batch.
*   **Network Resilience**: Automatic pause on network errors, exponential backoff health checks, and seamless resume on reconnection. Works in both addon and standalone modes.
*   **Persistence**: Server-side import logs with 30-second heartbeat, enabling resume from interrupted imports (addon mode).
*   **Intelligence**: Smart mapping suggestions for models and fields based on filename and header analysis.
*   **Repeatability**: Import Profiles allow saving complex multi-file configurations as ZIP files stored on the Odoo server.
*   **Flexibility**: Supports External IDs (upsert), Natural Keys, and Database IDs for record identification.

## Navigation

### [Getting Started](./getting-started/installation.md)
Learn how to install the Odoo addon and build the desktop client.

### [User Guide](./user-guide/connection.md)
A comprehensive guide on how to use the application, from connecting to a server to reviewing import results.

### [Technical Reference](./reference/strategies.md)
Detailed technical documentation on import strategies, transforms, and configuration options.

### [Developer Guide](./developer-guide/architecture.md)
Information for developers looking to understand the internals, run tests, or extend the tool.

*   [Architecture](./developer-guide/architecture.md) — Process model, network resilience, log lifecycle, embedded mode
*   [Odoo Backend](./developer-guide/odoo-backend.md) — API endpoints, data models, cron jobs, resume workflow
*   [Testing](./developer-guide/testing.md) — Unit tests (612+), E2E tests, Python tests
*   [Extending](./developer-guide/extending.md) — How to add new features

### [Standalone Mode](./standalone-mode.md)
Using the client without the Odoo addon — features, limitations, adaptive retry, and network resilience.

---
© 2026 Ametras GmbH. All rights reserved.
