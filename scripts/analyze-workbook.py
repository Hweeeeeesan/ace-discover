#!/usr/bin/env python3
"""Analyze one workbook with the canonical importer and emit only sanitized JSON."""

import importlib.util
import json
import pathlib
import sys

MODULE_PATH = pathlib.Path(__file__).with_name('import-master-apps.py')
SPEC = importlib.util.spec_from_file_location('ace_profile_importer', MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


def main():
    if len(sys.argv) != 3:
        print('Usage: analyze-workbook.py INPUT.xlsx OUTPUT.json', file=sys.stderr)
        return 2

    input_path = pathlib.Path(sys.argv[1])
    output_path = pathlib.Path(sys.argv[2])
    try:
        profiles, _ = IMPORTER.build_profiles(input_path)
        if not profiles:
            raise ValueError('The workbook did not contain any importable profiles.')
        payload = IMPORTER.build_dataset_payload(profiles)
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8',
        )
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
