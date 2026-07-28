# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Gerrit code review integration

The ``gerrit`` extension enables Gerrit-specific features. The ``sl gerrit
submit`` command is implemented in Rust and pushes commits for review via
``refs/for/<branch>``.

Gerrit detection is handled by :func:`detect.isgerrit`, which probes the
remote server and persists the result as ``gerrit.url`` in repo config.
"""

from .detect import isgerrit  # noqa: F401 – re-export for external callers
