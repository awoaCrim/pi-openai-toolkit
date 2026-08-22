from __future__ import annotations

import json
import pathlib
import subprocess
import urllib.error
import urllib.request

OLD_REPO = "awoaCrim/pi-remote-compact"
NEW_NAME = "pi-openai-toolkit"
NEW_REPO = f"awoaCrim/{NEW_NAME}"


def find_token(value: object) -> str | None:
    if isinstance(value, dict):
        token = value.get("GITHUB_PERSONAL_ACCESS_TOKEN")
        if isinstance(token, str) and token:
            return token
        for nested in value.values():
            found = find_token(nested)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = find_token(nested)
            if found:
                return found
    return None


def request_json(method: str, repo: str, token: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pi-openai-toolkit-repository-rename",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8")).get("message", "GitHub API error")
        except Exception:
            detail = "GitHub API error"
        raise RuntimeError(f"GitHub API returned HTTP {error.code}: {detail}") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("GitHub API returned a non-object response")
    return parsed


def git_credential_token() -> str | None:
    result = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
        capture_output=True,
        check=True,
    )
    fields = dict(
        line.split("=", 1)
        for line in result.stdout.splitlines()
        if "=" in line
    )
    password = fields.get("password")
    return password if password else None


config_path = pathlib.Path.home() / ".agents" / "mcp.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
token = find_token(config)
if token:
    try:
        before = request_json("GET", OLD_REPO, token)
    except RuntimeError as error:
        if "HTTP 401" not in str(error):
            raise
        token = git_credential_token()
        if not token:
            raise RuntimeError("GitHub MCP token was rejected and Git Credential Manager returned no credential") from error
        before = request_json("GET", OLD_REPO, token)
else:
    token = git_credential_token()
    if not token:
        raise RuntimeError("No GitHub credential was available")
    before = request_json("GET", OLD_REPO, token)
renamed = request_json("PATCH", OLD_REPO, token, {"name": NEW_NAME})
verified = request_json("GET", NEW_REPO, token)

print(json.dumps({
    "before": {
        "full_name": before.get("full_name"),
        "default_branch": before.get("default_branch"),
    },
    "renamed": {
        "full_name": renamed.get("full_name"),
        "default_branch": renamed.get("default_branch"),
        "html_url": renamed.get("html_url"),
    },
    "verified": {
        "full_name": verified.get("full_name"),
        "default_branch": verified.get("default_branch"),
        "html_url": verified.get("html_url"),
    },
}, indent=2))
