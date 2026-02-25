# Installation Guide

To use the CSV Import Tool, you need to set up both the Odoo backend and the desktop client.

## Prerequisites

*   **Odoo**: Version 16.0 or higher.
*   **Node.js**: Version 18.0 or higher (for building/running the client).
*   **npm**: Version 9.0 or higher.

## 1. Odoo Addon Installation

The Odoo addon provides the necessary API endpoints and the `csv.import.profile` model.

1.  Locate the `ametras_fast_import_addon` directory in the root of this project.
2.  Copy this directory to your Odoo addons path.
    ```bash
    cp -r ametras_fast_import_addon /your/odoo/addons/
    ```
3.  Restart your Odoo server.
4.  Log in to Odoo as an Administrator.
5.  Enable **Developer Mode**.
6.  Go to **Apps** -> **Update Apps List**.
7.  Search for "CSV Import" and click **Install**.

## 2. Desktop Client Setup

The client is an Electron application that can be run in development mode or packaged for production.

### Development Mode

1.  Navigate to the `csv-client` directory.
    ```bash
    cd csv-client
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the application:
    ```bash
    npm run dev              # web + Electron hybrid
    npm run dev:electron     # Electron-specific dev mode
    ```

### Building for Production

To create a standalone executable for your operating system:

1.  Build the frontend:
    ```bash
    npm run build
    ```
2.  Preview the production build locally (optional):
    ```bash
    npm run preview
    ```
3.  Package the application:
    ```bash
    npm run electron:build
    ```
4.  The resulting executable will be in the `release/` directory.

## 3. Network Requirements

*   The client must have network access to the Odoo server's JSON-RPC and HTTP ports (default is 8069).
*   If using HTTPS, ensure the server has a valid SSL certificate or configure the client to allow self-signed certificates (not recommended for production).
