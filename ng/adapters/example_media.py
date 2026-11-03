"""The example workflows' pictures, voice, song and videos ship in example_media and are copied into ComfyUI's input
folder when a workflow that names them is opened (js/ng/ng_example_media.js), not on start: an input folder should not fill
with files nobody asked for (issue #35). (Not "examples": ComfyUI serves a folder of that name as workflow templates.)
They sit at the input folder's top level (h3-example-*): a subfolder name would be spelled with "\\" on Windows and "/"
elsewhere, and a workflow saved on one would not find the file on the other. A file that is already there is never
overwritten."""
import logging
import os
import shutil

import folder_paths

SOURCE = os.path.join(os.path.dirname(__file__), "..", "..", "example_media")


def copy(names):
    """Copy those of `names` that ship with the pack and are missing from the input folder; returns the copied names."""
    shipped = set(os.listdir(SOURCE)) if os.path.isdir(SOURCE) else set()
    target, copied = folder_paths.get_input_directory(), []
    for name in sorted(set(names) & shipped):
        path = os.path.join(target, name)
        if os.path.exists(path):
            continue
        try:
            os.makedirs(target, exist_ok=True)
            shutil.copyfile(os.path.join(SOURCE, name), path)
            copied.append(name)
        except OSError as error:
            logging.warning("[H3 Director] could not copy the example file %s to the input folder: %s", name, error)
    return copied
