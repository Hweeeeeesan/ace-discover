#!/usr/bin/env python3
"""Adapt Google Sheets rows to XLSX tabular input, then run the canonical importer."""

import importlib.util
import json
import pathlib
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

MODULE_PATH = pathlib.Path(__file__).with_name('import-master-apps.py')
SPEC = importlib.util.spec_from_file_location('ace_profile_importer', MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)

REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
XML_NS = 'http://www.w3.org/XML/1998/namespace'


def column_name(index):
    value = index + 1
    name = ''
    while value:
        value, remainder = divmod(value - 1, 26)
        name = chr(65 + remainder) + name
    return name


def safe_xml_text(value):
    return ''.join(
        character for character in str(value or '')
        if character in '\t\n\r' or ord(character) >= 32
    )


def importer_sheet_name(source_title):
    key = IMPORTER._sheet_name_key(source_title)
    if key == 'form responses 1':
        return source_title
    if any(key in {IMPORTER._sheet_name_key(alias) for alias in config['aliases']} for config in IMPORTER.SHEETS.values()):
        return source_title
    # Google Forms response tabs are often renamed. Treat an otherwise selected
    # tab as the existing single-response-sheet layout; schema validation still
    # rejects incorrect headers before any public payload is produced.
    return 'Form Responses 1'


def write_tabular_xlsx(path, title, values):
    ET.register_namespace('', IMPORTER.MAIN)
    ET.register_namespace('r', REL_NS)

    worksheet = ET.Element(f'{{{IMPORTER.MAIN}}}worksheet')
    sheet_data = ET.SubElement(worksheet, f'{{{IMPORTER.MAIN}}}sheetData')
    for row_index, values_row in enumerate(values, start=1):
        row = ET.SubElement(sheet_data, f'{{{IMPORTER.MAIN}}}row', {'r': str(row_index)})
        for column_index, value in enumerate(values_row):
            text = safe_xml_text(value)
            if not text:
                continue
            reference = f'{column_name(column_index)}{row_index}'
            cell = ET.SubElement(row, f'{{{IMPORTER.MAIN}}}c', {'r': reference, 't': 'inlineStr'})
            inline = ET.SubElement(cell, f'{{{IMPORTER.MAIN}}}is')
            text_node = ET.SubElement(inline, f'{{{IMPORTER.MAIN}}}t')
            if text != text.strip():
                text_node.set(f'{{{XML_NS}}}space', 'preserve')
            text_node.text = text

    workbook = ET.Element(f'{{{IMPORTER.MAIN}}}workbook')
    sheets = ET.SubElement(workbook, f'{{{IMPORTER.MAIN}}}sheets')
    ET.SubElement(sheets, f'{{{IMPORTER.MAIN}}}sheet', {
        'name': importer_sheet_name(title),
        'sheetId': '1',
        f'{{{REL_NS}}}id': 'rId1',
    })

    relationships = ET.Element(f'{{{PACKAGE_REL_NS}}}Relationships')
    ET.SubElement(relationships, f'{{{PACKAGE_REL_NS}}}Relationship', {
        'Id': 'rId1',
        'Type': f'{REL_NS}/worksheet',
        'Target': 'worksheets/sheet1.xml',
    })

    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', ET.tostring(workbook, encoding='utf-8', xml_declaration=True))
        archive.writestr('xl/_rels/workbook.xml.rels', ET.tostring(relationships, encoding='utf-8', xml_declaration=True))
        archive.writestr('xl/worksheets/sheet1.xml', ET.tostring(worksheet, encoding='utf-8', xml_declaration=True))


def main():
    if len(sys.argv) != 3:
        print('Usage: analyze-sheet-values.py INPUT.json OUTPUT.json', file=sys.stderr)
        return 2

    try:
        source = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
        title = str(source.get('title') or '')
        values = source.get('values')
        if not title or not isinstance(values, list) or len(values) < 2:
            raise ValueError('The selected worksheet is empty or invalid.')
        with tempfile.TemporaryDirectory(prefix='ace-sheet-import-') as directory:
            workbook_path = pathlib.Path(directory) / 'sheet.xlsx'
            write_tabular_xlsx(workbook_path, title, values)
            profiles, _ = IMPORTER.build_profiles(workbook_path, allow_partial=True)
        if not profiles:
            raise ValueError('The worksheet did not contain any importable profiles.')
        payload = IMPORTER.build_dataset_payload(profiles)
        pathlib.Path(sys.argv[2]).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8',
        )
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
