"""The example files reach the input folder when a workflow names them (not on start, issue #35), at its top level, and
never overwrite a file of the same name."""
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from _pack import REPO, module, comfy_available

HAVE_COMFY = comfy_available()
SOURCE = Path(REPO) / "example_media"


@unittest.skipUnless(HAVE_COMFY, "needs ComfyUI's folder_paths")
class ExampleMedia(unittest.TestCase):
    def test_only_the_named_files_are_copied_and_present_ones_kept(self):
        media = module("ng.adapters.example_media")
        with tempfile.TemporaryDirectory() as inputs:
            Path(inputs, "h3-example-hero.jpg").write_bytes(b"mine")
            names = ["h3-example-hero.jpg", "h3-example-voice.wav", "h3-example-unknown.png", "../README.md"]
            with mock.patch.object(media.folder_paths, "get_input_directory", return_value=inputs):
                self.assertEqual(media.copy(names), ["h3-example-voice.wav"])
                self.assertEqual(media.copy(names), [], "a second open copies nothing")
            self.assertEqual(Path(inputs, "h3-example-hero.jpg").read_bytes(), b"mine")
            self.assertEqual(sorted(os.listdir(inputs)), ["h3-example-hero.jpg", "h3-example-voice.wav"])

    def test_nothing_is_copied_on_start(self):
        source = (Path(REPO) / "ng" / "nodes" / "__init__.py").read_text(encoding="utf8")
        self.assertNotIn("example_media", source)


class ExampleWorkflowsUseTheShippedFiles(unittest.TestCase):
    def test_every_example_file_a_workflow_names_is_shipped(self):
        shipped = set(os.listdir(SOURCE))
        for path in (Path(REPO) / "example_workflows").glob("H3 Director - *.json"):
            for name in set(re.findall(r"h3-example-[\w.-]+\.\w+", path.read_text(encoding="utf8"))):
                self.assertIn(name, shipped, path.stem)


if __name__ == "__main__":
    unittest.main()
