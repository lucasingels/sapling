#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Fills in brew_formula_eden.rb's %URL%/%VERSION%/%SHA256% placeholders.

Unlike prepare_formula.py (the plain `sapling` formula, which builds inside
`brew install --build-bottle` from a source tarball), sapling-eden ships a
prebuilt tarball assembled by assemble_eden_prefix.sh and already uploaded to
a GitHub release by the time this runs -- so there is no bottling step, no
cache dir, and no source tarball to create here. Just template substitution.
"""

import argparse
import hashlib
import os


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-r", "--release-version", required=True, help="Version for sapling-eden"
    )
    parser.add_argument(
        "-u", "--url", required=True, help="Download URL for the release tarball"
    )
    parser.add_argument(
        "-t",
        "--tarball",
        required=True,
        help="Path to the local tarball to hash (its sha256 is embedded)",
    )
    parser.add_argument(
        "-o",
        "--formula-out",
        default="sapling-eden.rb",
        type=str,
        help="Location of the resultant filled-in formula",
    )
    args = parser.parse_args()

    template_path = os.path.join(os.path.dirname(__file__), "brew_formula_eden.rb")
    with open(template_path) as f:
        formula = f.read()

    formula = formula.replace("%URL%", args.url)
    formula = formula.replace("%VERSION%", args.release_version)
    formula = formula.replace("%SHA256%", sha256_of(args.tarball))

    with open(args.formula_out, "w") as f:
        f.write(formula)


if __name__ == "__main__":
    main()
