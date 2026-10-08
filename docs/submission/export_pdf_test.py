import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('submission_export', Path(__file__).with_name('export_pdf.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).with_name('oschina-2026.md')
        self.exporter = module.Exporter(Path('/System/Library/Fonts/STHeiti Light.ttc'), [self.source, self.source.with_name('oschina-2026-evidence.md')])

    def test_links_preserve_history_and_keep_local_sources_explicit(self):
        historical = 'https://github.com/JadeSnow7/web-studio-lab/blob/606556c/README.md'
        self.assertEqual(self.exporter.link(historical, self.source), historical)
        for index in range(1, 15):
            self.assertEqual(self.exporter.link(f'oschina-2026-evidence.md#e{index:02d}', self.source), f'#e{index:02d}')
        self.assertEqual(self.exporter.link('../../README.md', self.source), (module.ROOT / 'README.md').as_uri())
        with self.assertRaisesRegex(ValueError, 'Missing relative link'):
            self.exporter.link('does-not-exist.md', self.source)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.exporter.link('../../../../outside.md', self.source)
        self.assertEqual(self.exporter.manuscript_date, '2026-10-08')

    def test_pdf_exports_with_internal_and_local_links_and_refuses_acceptance_output(self):
        from pypdf import PdfReader
        with tempfile.TemporaryDirectory(prefix='wsl-submission-export-') as directory:
            output = Path(directory) / 'draft.pdf'
            self.exporter.export(output)
            reader = PdfReader(output)
            text = '\n'.join(page.extract_text() for page in reader.pages)
            self.assertIn('稿件日期 2026-10-08', text)
            self.assertIn('本地文件', text)
            annotations = [item.get_object() for page in reader.pages for item in page.get('/Annots', [])]
            self.assertTrue(any(item.get('/Dest') for item in annotations))
            self.assertTrue(any(str(item.get('/A', {}).get('/URI', '')).startswith('file:') for item in annotations))
        rejected = subprocess.run([__import__('sys').executable, str(Path(__file__).with_name('export_pdf.py')), '--font', '/System/Library/Fonts/STHeiti Light.ttc', '--output', str(module.ROOT / 'docs/acceptance/refused.pdf')], capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('must not be inside docs/acceptance', rejected.stderr)

if __name__ == '__main__':
    unittest.main()
