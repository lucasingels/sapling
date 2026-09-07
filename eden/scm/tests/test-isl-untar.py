# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

import io
import os
import shutil
import tarfile
import tempfile
import unittest

from sapling.commands import isl


def make_tar(path, source_hash, files):
    """write a PAX tar at path with the given source_hash header and {name: content}"""
    with tarfile.open(
        path, "w", format=tarfile.PAX_FORMAT, pax_headers={"source_hash": source_hash}
    ) as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class testisluntar(unittest.TestCase):
    def setUp(self):
        self._testdir = tempfile.mkdtemp("isluntartest")
        self._dest = os.path.join(self._testdir, "ISL")

    def tearDown(self):
        shutil.rmtree(self._testdir, True)

    def testfreshextractisnotareplacement(self):
        tar = os.path.join(self._testdir, "a.tar")
        make_tar(tar, "hash-a", {"isl/index.html": "a"})
        metadata, replaced = isl.untar(tar, self._dest)
        self.assertEqual(metadata.get("source_hash"), "hash-a")
        self.assertFalse(replaced)
        self.assertTrue(os.path.exists(os.path.join(self._dest, "isl", "index.html")))

    def testsametarballisnotreextracted(self):
        tar = os.path.join(self._testdir, "a.tar")
        make_tar(tar, "hash-a", {"isl/index.html": "a"})
        isl.untar(tar, self._dest)
        marker = os.path.join(self._dest, "marker")
        with open(marker, "w") as f:
            f.write("keep")
        _, replaced = isl.untar(tar, self._dest)
        self.assertFalse(replaced)
        # nothing was deleted or re-extracted
        self.assertTrue(os.path.exists(marker))

    def testnewtarballreplacesoldextraction(self):
        tar_a = os.path.join(self._testdir, "a.tar")
        tar_b = os.path.join(self._testdir, "b.tar")
        make_tar(tar_a, "hash-a", {"isl/assets/old-AAAA.js": "old"})
        make_tar(tar_b, "hash-b", {"isl/assets/new-BBBB.js": "new"})
        isl.untar(tar_a, self._dest)
        _, replaced = isl.untar(tar_b, self._dest)
        self.assertTrue(replaced)
        assets = os.path.join(self._dest, "isl", "assets")
        self.assertEqual(sorted(os.listdir(assets)), ["new-BBBB.js"])
        with open(os.path.join(self._dest, ".source_hash"), "rb") as f:
            self.assertEqual(f.read(), b"hash-b")


if __name__ == "__main__":
    import silenttestrunner

    silenttestrunner.main(__name__)
