# Quickstart Guide

Follow these steps to perform your first import using the CSV Import Tool.

## Step 1: Connect to Odoo

1.  Launch the CSV Import Tool.
2.  Enter your Odoo server URL (e.g., `http://localhost:8069`).
3.  Select the database.
4.  Enter your username and password.
5.  Click **Connect**.

## Step 2: Select Files

1.  On the **Files** view, drag and drop one or more CSV files into the application, or click the drop zone to select files via the file browser.
2.  The files will appear in a list. The application will automatically analyze the headers and the first few rows of each file.
3.  Click the chevron icon next to a filename to preview the data.

## Step 3: Configure Mappings

1.  Click the **Configure** link in the top navigation bar.
2.  For each file:
    *   Select the target **Odoo Model**. The app will provide suggestions based on the filename.
    *   Click **Map Fields**.
    *   The app will automatically suggest mappings for CSV headers to Odoo fields.
    *   Review the mappings. Pay attention to relational fields (Many2One, Many2Many) and ensure the correct transform is selected (e.g., `m2o_ref` for External IDs).
3.  Adjust **Run Settings** if necessary (Batch Size, Workers, etc.).

## Step 4: Validate and Run

1.  Observe the status indicator (colored dot) next to each file. It must be green for all files before you can start.
2.  Click the **Run Import** button in the top navigation bar.
3.  Review the import plan.
4.  Click **Start Import**.

## Step 5: Monitor Progress

1.  The **Run** view shows the overall progress and per-file status.
2.  You can see the number of rows processed, success count, and error count.
3.  If errors occur, you can pause the import to investigate or let it continue.

## Step 6: Review Results

1.  Once completed, you will be taken to the **Results** view.
2.  Review any failed rows.
3.  Click **Export Errors** to download a CSV file containing only the failed rows and their error messages. This file can be fixed and re-imported.
