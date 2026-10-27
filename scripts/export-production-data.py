#!/usr/bin/env python3
"""Supplement a dashboard daily backup with current rows, without a DB password.

Human runs: python3 scripts/export-production-data.py
Uses the Supabase CLI account login via macOS Keychain (or SUPABASE_ACCESS_TOKEN).
All remote SQL transactions are READ ONLY. No table data or credentials are printed.
This is a per-table recovery export, NOT a pg_dump or one database-wide snapshot.
"""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

PROJECT = "dxttnbtfhpanyiyduevn"
API = f"https://api.supabase.com/v1/projects/{PROJECT}/database/query"


def now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat()


def token():
    value = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not value:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise RuntimeError("Supabase account login unavailable. Run supabase login first.")
        value = result.stdout.strip()
        if value.startswith("go-keyring-base64:"):
            value = base64.b64decode(value.split(":", 1)[1], validate=True).decode()
    if not value:
        raise RuntimeError("Supabase account token is empty.")
    return value


def query(sql, access_token):
    request = urllib.request.Request(
        API,
        data=json.dumps({"query": f"BEGIN READ ONLY; {sql}; COMMIT;"}).encode(),
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        # Do not print API error bodies, which can include database values.
        raise RuntimeError(f"Management API HTTP {exc.code}; export stopped.") from None
    data = json.loads(raw)
    if not isinstance(data, list):
        raise RuntimeError("Unexpected API response; export stopped.")
    return data, raw


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def validate_table(data):
    if len(data) != 1 or not isinstance(data[0], dict):
        raise RuntimeError("Invalid table export envelope.")
    entry = data[0]
    if not isinstance(entry.get("rows"), list):
        raise RuntimeError("Missing table rows; export may be truncated.")
    if not isinstance(entry.get("row_count"), int) or entry["row_count"] != len(entry["rows"]):
        raise RuntimeError("Row count does not match exported data.")
    return entry["row_count"]


def verify(folder):
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest["status"] != "TABLE EXPORT COMPLETE" or manifest["project_ref"] != PROJECT:
        raise RuntimeError("Manifest is not a completed production table export.")
    for item in manifest["files"]:
        raw = (folder / item["file"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {item['file']}")
        if "row_count" in item and validate_table(json.loads(raw)) != item["row_count"]:
            raise RuntimeError(f"Row count mismatch: {item['file']}")
    return len(manifest["files"])


def export(folder, access_token):
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest = {
        "project_ref": PROJECT, "started_at": now(), "status": "NOT COMPLETE",
        "consistency": "Each table is exported in one read-only transaction; tables have different snapshots.",
        "restore_baseline": "Supabase dashboard daily backup; exports require manual reconciliation.",
        "excludes": ["Storage file contents", "standalone schema restore", "changes after each table export"],
        "files": [],
    }

    def checkpoint():
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def save(name, raw, **metadata):
        (folder / name).write_bytes(raw)
        manifest["files"].append({"file": name, "sha256": hashlib.sha256(raw).hexdigest(), **metadata})
        checkpoint()

    checkpoint()
    tables, raw = query(
        "SELECT n.nspname AS schema_name, c.relname AS table_name "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p') "
        "AND NOT c.relispartition ORDER BY 1,2", access_token,
    )
    if not tables or not any(t["table_name"] == "bookings" and t["schema_name"] == "public" for t in tables):
        raise RuntimeError("Production bookings table not found in inventory.")
    save("table-inventory.json", raw)
    _, raw = query(
        "SELECT to_regprocedure('public.is_admin()') IS NOT NULL AS is_admin_exists, "
        "EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid "
        "WHERE t.tgrelid='public.bookings'::regclass AND p.proname='generate_ref_number') AS ref_trigger_exists, "
        "to_regclass('public.booking_orders') IS NOT NULL AS booking_orders_already_exists, "
        "(SELECT count(*) FROM public.pending_bookings WHERE expires_at>now()) AS checkouts_in_flight, "
        "(SELECT count(*) FROM (SELECT 1 FROM public.payments WHERE reference_number IS NOT NULL "
        "GROUP BY reference_number,booking_id HAVING count(*)>1) duplicates) AS duplicate_payment_groups, "
        "(SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid))) "
        "FROM pg_constraint WHERE conrelid='public.payments'::regclass AND contype IN ('u','p')) AS payment_constraints",
        access_token,
    )
    save("preflight.json", raw)
    for index, table in enumerate(tables, 1):
        schema, name = table["schema_name"], table["table_name"]
        # Production identifiers are catalog-supplied, quoted for SQL, and checked for safe filenames.
        if not all(part.replace("_", "").isalnum() for part in (schema, name)):
            raise RuntimeError("Unexpected table name; refusing unsafe output path.")
        data, raw = query(
            f"SELECT count(*) AS row_count, statement_timestamp() AS exported_at, "
            f"COALESCE(json_agg(t), '[]'::json) AS rows FROM {identifier(schema)}.{identifier(name)} t",
            access_token,
        )
        count = validate_table(data)
        save(f"{schema}.{name}.json", raw, row_count=count, exported_at=data[0]["exported_at"])
        print(f"  {index}/{len(tables)} {schema}.{name}: {count} rows", flush=True)
    manifest["finished_at"] = now()
    manifest["status"] = "TABLE EXPORT COMPLETE"
    checkpoint()
    verify(folder)
    files = sorted(p for p in folder.iterdir() if p.is_file())
    (folder / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files
    ))
    print(f"\nTABLE EXPORT COMPLETE: {folder}")
    print("Local JSON files, row counts, and checksums verified. Restore has NOT been tested.")
    print("Use with the dashboard daily backup. This is NOT a full database backup or one shared snapshot.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path, help="Recheck a saved export locally; no remote access")
    args = parser.parse_args()
    os.umask(0o077)
    if args.verify:
        print(f"Verified {verify(args.verify)} exported files; no remote access.")
        return
    folder = Path.home() / "Backups" / "barkhaus" / (
        datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S")
        + "-" + uuid.uuid4().hex[:8] + "-table-recovery"
    )
    try:
        export(folder, token())
    except Exception as exc:
        # Unsuccessful runs retain NOT COMPLETE manifests and never satisfy the release gate.
        if (folder / "manifest.json").exists():
            incomplete = json.loads((folder / "manifest.json").read_text())
            incomplete["status"] = "NOT COMPLETE"
            (folder / "manifest.json").write_text(json.dumps(incomplete, indent=2) + "\n")
        print(f"NOT COMPLETE: {exc}\nFolder: {folder}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
