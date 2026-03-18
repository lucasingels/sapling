# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

"""Gerrit server detection.

Detects whether a remote URL points to a Gerrit server by probing it.
The detection result is persisted as ``gerrit.url`` in repo config, which
serves as the single gate for Gerrit-specific behavior in both the CLI
and ISL (which already reads ``gerrit.url``).

Detection logic mirrors ISL's ``isGerritRemote()`` and ``parseGerritRemote()``
in ``addons/isl-server/src/gerrit/gerritCodeReviewProvider.ts``.
"""

from urllib.parse import urlparse


def isgerrit(ui, repo):
    """Detect whether the remote is a Gerrit server.

    ``gerrit.url`` is the single gate. If not set, probes the server and
    sets ``gerrit.url`` on success (so future calls and ISL both use it).
    """
    if ui.config("gerrit", "url"):
        return True
    # Probe the server
    default = ui.config("paths", "default") or ""
    gerrit_url = probe_gerrit(default)
    if gerrit_url and repo:
        # Persist gerrit.url — single source of truth for CLI and ISL
        from sapling import rcutil

        configfile = repo.localvfs.join(ui.identity.configrepofile())
        rcutil.editconfig(ui, configfile, "gerrit", "url", gerrit_url)
    return bool(gerrit_url)


def probe_gerrit(remote_url):
    """Probe a remote URL to determine if it's a Gerrit server.

    Returns the Gerrit web URL (e.g. ``https://gerrit.example.com``) on
    success, or ``None`` if it's not Gerrit.

    SSH: runs ``ssh -p {port} {host} gerrit version``, derives HTTP URL.
    HTTP/HTTPS: hits ``GET {url}/config/server/version``.
    """
    try:
        parsed = urlparse(remote_url)
    except Exception:
        return None

    if parsed.scheme == "ssh":
        host = parsed.hostname or ""
        port = parsed.port or 29418
        if _probe_gerrit_ssh(host, port):
            # Derive web URL: strip ssh. prefix (mirrors ISL parseGerritRemote)
            web_host = host[4:] if host.startswith("ssh.") else host
            return "https://%s" % web_host
        return None
    elif parsed.scheme in ("http", "https"):
        base = "%s://%s" % (parsed.scheme, parsed.netloc)
        if _probe_gerrit_http(base):
            return base
    return None


def _probe_gerrit_ssh(host, port):
    """Probe via SSH: ``ssh -p {port} {host} gerrit version``."""
    import subprocess

    try:
        result = subprocess.run(
            [
                "ssh",
                "-p",
                str(port),
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "BatchMode=yes",
                host,
                "gerrit",
                "version",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0 and "gerrit version" in result.stdout
    except Exception:
        return False


def _probe_gerrit_http(base_url):
    """Probe via HTTP: ``GET {base_url}/config/server/version``."""
    try:
        from urllib.request import Request, urlopen

        req = Request("%s/config/server/version" % base_url, method="GET")
        resp = urlopen(req, timeout=5)
        return resp.status == 200
    except Exception:
        return False
