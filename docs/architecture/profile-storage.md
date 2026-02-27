# Profile Storage: Architecture & Trade-offs

## Overview

The CSV Import Client supports three profile storage backends depending on the deployment mode and whether the `ametras_fast_import` addon is installed.

| Backend | Storage | IDs | Requires Addon | Shared | Offline |
|---------|---------|-----|----------------|--------|---------|
| **Addon** (`profileApi.ts`) | `csv.import.profile` model | Positive (server) | Yes | Yes | No |
| **Attachment** (`attachmentProfiles.ts`) | `ir.attachment` records | Positive (server) | No | No | No |
| **Local** (Electron store) | `~/.config/.../csv-import-store.json` | Negative | No | No | Yes |

## Backend Details

### 1. Addon — `csv.import.profile` Model

Used when `ametras_fast_import` is installed (import mode = `addon`).

- Profiles stored in a dedicated Odoo model with proper fields for name, version, mappings, sequence, run settings, and field mappings.
- Custom HTTP endpoints: `/ametras_fast_import/profile/{list,create,update,delete}`.
- Server-side ZIP upload and export via Electron IPC (`window.api.profile.upload/export`).
- ACL: `base.group_user` — all internal users have full CRUD access.
- Profiles are visible in Odoo backend under Settings > Technical.

### 2. Attachment — `ir.attachment` Records

Used in standalone mode for server-stored profiles (import mode = `standalone`).

- Profile data stored as a base64-encoded JSON blob in the `datas` field.
- Identified by name prefix `csv_import_profile/` (no `res_model` set, since `csv.import.profile` doesn't exist without the addon).
- Uses generic `ir.attachment` CRUD via `/web/dataset/call_kw` — no custom endpoints or addon required.
- Works on any Odoo instance out of the box.

### 3. Local — Electron Store

Available in all modes. ZIP imports always create local profiles.

- Stored in the Electron app's local JSON file.
- Negative IDs to distinguish from server-assigned positive IDs.
- No network required — works offline.
- Tied to the machine; not shared, not synced.
- Users can push local profiles to server via "Push to Server" action.

## Access Control: Why Attachments Are Per-User

Odoo's `ir.attachment` access rules:

| `res_model` value | Access behavior |
|-------------------|----------------|
| Set to a real model + `res_id` | Inherits the linked record's ACL |
| Set to a non-existent model | `AccessError` — Odoo validates the model exists |
| Empty / not set | **Private to `create_uid`** — only the owner can read/write/delete |

Since we cannot set `res_model` to `csv.import.profile` (the model doesn't exist without the addon), attachments are created without `res_model`. This means:

- Each user only sees their own profiles.
- There is no built-in mechanism to share attachment-based profiles between users.
- Setting `public: True` on the attachment only affects URL-based download, not `search_read` visibility for other internal users.

## Trade-off Summary

| Concern | Addon Model | Attachment | Local |
|---------|------------|------------|-------|
| **No addon required** | No | Yes | Yes |
| **Multi-user / shared** | Yes (all employees) | No (owner only) | No (single machine) |
| **Cross-device** | Yes | Yes | No |
| **Offline capable** | No | No | Yes |
| **Backend visibility** | Full (dedicated model, menu) | Buried in ir.attachment list | N/A |
| **Server-side validation** | Yes (endpoint validates) | No (client sends blob) | N/A |
| **ZIP upload** | Server-side parsing | Client-side parsing | Client-side parsing |
| **ZIP export** | Server-side generation | Client-side generation | Client-side generation |

## When to Use What

- **Addon installed, team usage**: Addon model. Profiles are shared, validated, and visible in the backend.
- **No addon, single user**: Attachment + Local. Profiles live on the server (attachment) for cross-device access, or locally for offline use. Users can push local profiles to the server when connected.
- **Offline / air-gapped**: Local only. ZIP import/export for transferring profiles between machines.

## Could We Unify to Attachments Only?

Technically yes — the CRUD operations are equivalent. But:

1. **Shared profiles break.** Without a real `res_model`, attachments are private. Teams that rely on shared profiles would lose access.
2. **Backend discoverability degrades.** Admins can no longer browse profiles in Odoo's backend UI under a dedicated menu; they'd need to filter `ir.attachment` by name prefix.
3. **Server-side validation is lost.** The addon endpoints validate profile structure before saving. Attachments store whatever the client sends.

**Conclusion:** The addon model remains the right choice when the addon is installed and profiles need to be shared. Attachments are the pragmatic solution for standalone single-user mode where no addon is available.
