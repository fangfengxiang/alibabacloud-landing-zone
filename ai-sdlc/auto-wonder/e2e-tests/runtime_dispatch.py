#!/usr/bin/env python3
"""Opt-in real executor dispatch check. Never print raw exceptions or responses."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import hashlib
import re
import secrets
import signal
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

class CheckFailure(Exception):
    """Contains only a fixed, non-secret failure code."""


def valid_runtime_version(value):
    return isinstance(value, str) and re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", value) is not None


def source_runtime_version(project_root):
    # Match the deployment Skill's exact YAML namespace and placeholder contract
    # without requiring a global Python YAML package or evaluating environment.
    parents, values, mappings = {}, [], set()
    target = ("autowonder", "runtime", "recommended-version")
    try:
        with (project_root / "src/main/resources/application.yml").open(encoding="utf-8") as stream:
            for raw in stream:
                if not raw.strip() or raw.lstrip().startswith("#"):
                    continue
                match = re.match(r"^( *)([A-Za-z0-9-]+)\s*:\s*(.*?)\s*$", raw.rstrip("\r\n"))
                if not match:
                    continue
                indent, key, scalar = len(match.group(1)), match.group(2), match.group(3)
                parents = {level: name for level, name in parents.items() if level < indent}
                current = tuple(parents[level] for level in sorted(parents)) + (key,)
                scalar = scalar.split(" #", 1)[0].strip()
                if current == target:
                    values.append(scalar.strip('"\''))
                if not scalar:
                    if current in (target[:1], target[:2]) and current in mappings:
                        raise CheckFailure("RUNTIME_SOURCE_RECOMMENDATION_INVALID")
                    mappings.add(current)
                    parents[indent] = key
    except (OSError, UnicodeError):
        raise CheckFailure("RUNTIME_SOURCE_RECOMMENDATION_INVALID") from None
    if len(values) != 1:
        raise CheckFailure("RUNTIME_SOURCE_RECOMMENDATION_INVALID")
    value = values[0]
    placeholder = re.fullmatch(r"\$\{AUTOWONDER_RUNTIME_RECOMMENDED_VERSION:([^}]+)\}", value)
    if placeholder:
        value = placeholder.group(1)
    if not valid_runtime_version(value):
        raise CheckFailure("RUNTIME_SOURCE_RECOMMENDATION_INVALID")
    return value


def resolve_runtime_recommendation(project_root, state=None, base=None):
    source = source_runtime_version(project_root)
    result = {"sourceRuntimeVersion": source, "runtimeVersion": source,
              "runtimeRecommendationSource": "application.yml"}
    if state is None and base is None:
        return result
    if state is None or base is None:
        raise CheckFailure("RUNTIME_RECOMMENDATION_CONTEXT_REQUIRED")
    env_file = state / "app.env"
    if not state.is_dir() or state.is_symlink() or env_file.is_symlink():
        raise CheckFailure("RUNTIME_DEPLOYMENT_ENV_REQUIRED")
    overrides = []
    try:
        with env_file.open(encoding="utf-8") as stream:
            for line in stream:
                key, sep, value = line.rstrip("\r\n").partition("=")
                if sep and key == "AUTOWONDER_RUNTIME_RECOMMENDED_VERSION":
                    overrides.append(value)
    except (OSError, UnicodeError):
        raise CheckFailure("RUNTIME_DEPLOYMENT_ENV_REQUIRED") from None
    if overrides:
        if len(overrides) != 1 or not valid_runtime_version(overrides[0]):
            raise CheckFailure("RUNTIME_DEPLOYMENT_RECOMMENDATION_INVALID")
        result.update(runtimeVersion=overrides[0], runtimeRecommendationSource="lifecycle-app.env")
    api = Api(base)
    try:
        branding = api.call("GET", "/api/platform/branding/public")
    except CheckFailure:
        raise CheckFailure("RUNTIME_RECOMMENDATION_API_FAILED") from None
    live = branding.get("recommendedRuntimeVersion") if isinstance(branding, dict) else None
    if not valid_runtime_version(live):
        raise CheckFailure("RUNTIME_RECOMMENDATION_API_INVALID")
    if live != result["runtimeVersion"]:
        raise CheckFailure("RUNTIME_RECOMMENDATION_MISMATCH")
    return result


def require_api_success(body):
    if not isinstance(body, dict) or body.get("success") is not True:
        raise CheckFailure("API_BUSINESS_FAILURE")
    return body.get("data")


def require_artifact(actual, expected):
    if actual != expected:
        raise CheckFailure("ARTIFACT_CONTENT_MISMATCH")
    return hashlib.sha256(actual).hexdigest()


def step_request(instruction):
    # Routing columns are optional JSON, not enum strings. A one-step workflow
    # needs no explicit routing rule; the runtime completes its sole step.
    return {"name": "Deliver proof", "stepOrder": 1, "kind": "WORK", "code": "deliver-proof",
            "handlerType": "AGENT", "instructionMd": instruction, "required": True,
            "timeoutSeconds": 300, "retryBudget": 0}


RUNTIME_CLIENT_KINDS = {"qoder": "QODER_CLI", "codex": "CODEX_CLI", "claude": "CLAUDE_CODE",
                        "opencode": "OPENCODE_CLI", "codebuddy": "CODEBUDDY_CLI"}
OPENCODE_MIN_VERSION = (2, 2, 3)
CODEBUDDY_MIN_VERSION = (2, 100, 0)
CODEBUDDY_ENV = ("CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_API_KEY")
CLAUDE_GATEWAY_ENV = ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
                      "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                      "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")


def claude_gateway_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()
                or (os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
                    and os.environ.get("ANTHROPIC_BASE_URL", "").strip()))


def opencode_environment():
    try:
        home = Path(os.environ.get("AW_E2E_OPENCODE_HOME", ""))
        if not home.is_absolute() or home.is_symlink():
            raise ValueError
        root = home.resolve(strict=True)
        user_home = Path.home().resolve()
        if (root == user_home or root in user_home.parents or not root.is_dir()
                or root.stat().st_mode & 0o077):
            raise ValueError
        env = {}
        for name in ("config", "data", "state", "cache"):
            directory = root / name
            if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
                raise ValueError
            env[f"XDG_{name.upper()}_HOME"] = str(directory)
        return env
    except (OSError, RuntimeError, ValueError):
        raise CheckFailure("OPENCODE_TEST_HOME_REQUIRED") from None


def reserve_executor(api, agent_id, lock_root, provider="qoder"):
    # Fresh databases reuse numeric IDs. Never overwrite a host runtime lock
    # belonging to another server/run, even if that lock is currently inactive.
    occupied = {path.name for path in lock_root.glob("executor-*.lock")
                if re.fullmatch(r"executor-[0-9]+\.lock", path.name)}
    seen = set()
    # With distinct new IDs, N occupied names can block at most N candidates.
    # Concurrent new locks still fail closed within this snapshot-derived bound.
    for _ in range(len(occupied) + 1):
        executor = api.call("POST", f"/api/agents/{agent_id}/executors",
                           {"name": "runtime-e2e", "clientKind": RUNTIME_CLIENT_KINDS[provider]})
        executor_id = int(executor["id"])
        lock = lock_root / f"executor-{executor_id}.lock"
        repeated = executor_id in seen
        if not repeated and not lock.exists() and not lock.is_symlink():
            return executor
        api.call("DELETE", f"/api/executors/{executor_id}")
        if repeated:
            raise CheckFailure("ISOLATED_EXECUTOR_ID_UNAVAILABLE")
        seen.add(executor_id)
    raise CheckFailure("ISOLATED_EXECUTOR_ID_UNAVAILABLE")


def require_dispatch(dispatch, expected):
    if dispatch.get("status") != "SUCCEEDED":
        raise CheckFailure("DISPATCH_NOT_SUCCEEDED")
    if any(dispatch.get(key) != value for key, value in expected.items()):
        raise CheckFailure("DISPATCH_ROUTING_MISMATCH")


def validate_download(url, origin):
    parsed, allowed = urlsplit(url), urlsplit(origin)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.netloc != allowed.netloc or parsed.username or parsed.password
            or parsed.fragment):
        raise CheckFailure("DOWNLOAD_DESTINATION_REJECTED")


def select_artifact(artifacts, dispatch_id):
    matches = [item for item in artifacts if item.get("dispatchId") == dispatch_id
               and Path(item.get("name", "")).name == "runtime-proof.txt"]
    if len(matches) != 1:
        raise CheckFailure("ARTIFACT_MISSING_OR_AMBIGUOUS")
    return matches[0]["id"]


def require_transitions(log, dispatch_id):
    text = log.read_text(errors="replace")
    for status in ("ACKED", "RUNNING",):
        if not re.search(rf"dispatch transition dispatchId={int(dispatch_id)} status={status}\b", text):
            raise CheckFailure("DISPATCH_TRANSITION_EVIDENCE_MISSING")


def wait_for(probe, timeout, failure):
    deadline = time.monotonic() + timeout
    while True:
        result = probe()
        if result:
            return result
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CheckFailure(failure)
        time.sleep(min(.5, remaining))


EVIDENCE_KEYS = frozenset(("verdict", "runtimeVersion", "workspaceId", "agentId",
    "agentVersionId", "executorId", "workitemId", "dispatchId", "stepId", "artifactId",
    "artifactSha256", "checks", "cleanup", "failureKind", "cleanupLogStart", "cleanupLogEnd",
    "sourceRuntimeVersion", "runtimeRecommendationSource", "provider", "runtimeFailureCode"))


def log_line_counts(state):
    counts = {}
    for source, name in (("stdout", "spring-boot-console.log"), ("file", "auto-wonder.log")):
        path = state / "logs" / name
        if path.is_file():
            with path.open(errors="replace") as stream:
                counts[source] = sum(1 for _ in stream)
    return counts


def write_evidence(path, evidence):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump({k: v for k, v in evidence.items() if k in EVIDENCE_KEYS}, stream, indent=2)
        stream.write("\n")


class OwnedRuntime:
    """Foreground child and private work directory; never touches global CLI state."""
    def __init__(self, argv, connection_env, parent):
        self.argv, self.connection_env, self.parent = argv, connection_env, parent
        self.process = None
        self.directory = None
        self.cleaned = False
        self.lock_path = None

    def __enter__(self):
        executor_id = self.connection_env.get("AUTOWONDER_EXECUTOR_ID")
        if executor_id:
            self.lock_path = Path.home() / ".autowonder/run" / f"executor-{int(executor_id)}.lock"
            if self.lock_path.exists() or self.lock_path.is_symlink():
                raise CheckFailure("RUNTIME_LOCK_ALREADY_EXISTS")
        self.directory = tempfile.TemporaryDirectory(prefix="runtime-private-", dir=self.parent)
        root = self.directory.name
        provider = self.connection_env.get("AUTOWONDER_PROVIDER")
        # Do not forward unrelated credentials or runtime settings from the host.
        env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG",
               "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY") if k in os.environ}
        if provider == "codex":
            env["CODEX_HOME"] = os.environ["AW_E2E_CODEX_HOME"]
        elif provider == "claude":
            if claude_gateway_configured():
                env.update({key: os.environ[key] for key in CLAUDE_GATEWAY_ENV if key in os.environ})
                claude_home = Path(root) / "claude"
                claude_home.mkdir(mode=0o700)
                (claude_home / ".claude.json").write_text('{"hasCompletedOnboarding":true}')
                env["CLAUDE_CONFIG_DIR"] = str(claude_home)
            else:
                env["CLAUDE_CONFIG_DIR"] = os.environ["AW_E2E_CLAUDE_HOME"]
        elif provider == "opencode":
            try:
                env.update(opencode_environment())
                isolated_home = Path(root) / "home"
                isolated_home.mkdir(mode=0o700)
                env.update(HOME=str(isolated_home), TMPDIR=root)
                if os.environ.get("DASHSCOPE_API_KEY", "").strip():
                    env["DASHSCOPE_API_KEY"] = os.environ["DASHSCOPE_API_KEY"]
            except BaseException:
                self.directory.cleanup()
                raise
        elif provider == "codebuddy":
            # CodeBuddy Code 认证走登录态文件或环境令牌；检查环境只透传已注入的令牌。
            for name in CODEBUDDY_ENV:
                if os.environ.get(name, "").strip():
                    env[name] = os.environ[name]
        elif "QODER_PERSONAL_ACCESS_TOKEN" in os.environ:
            env["QODER_PERSONAL_ACCESS_TOKEN"] = os.environ["QODER_PERSONAL_ACCESS_TOKEN"]
        env.update(self.connection_env)
        env.update(AUTOWONDER_WORKSPACE_ROOT=root + "/workspaces",
                   AUTOWONDER_ASSIGNMENT_QUEUE_DIR=root + "/assignments",
                   AUTOWONDER_LOCAL_API_ADDR="127.0.0.1:0",
                   AUTOWONDER_MEMORY_MODE="none", AUTOWONDER_MAX_CONCURRENT_DISPATCHES="1",
                   QODER_CONFIG_DIR=root + "/qoder", AUTOWONDER_AUTO_UPDATE_INITIAL_DELAY="24h")
        try:
            self.process = subprocess.Popen(self.argv, env=env, cwd=root,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
        except BaseException:
            self.directory.cleanup()
            raise
        return self.process

    def __exit__(self, *unused):
        # Qoder creates its own process group. Snapshot numeric ancestry before
        # stopping the daemon; never inspect command lines or match process names.
        rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid="], text=True)
        table = [tuple(map(int, line.split())) for line in rows.splitlines() if line.strip()]
        descendants = {self.process.pid}
        while True:
            expanded = descendants | {pid for pid, ppid, _ in table if ppid in descendants}
            if expanded == descendants:
                break
            descendants = expanded
        groups = {pgid for pid, _, pgid in table if pid in descendants and pgid in descendants}
        # A crashed daemon may have orphaned Qoder before __exit__. Its separate
        # group still belongs to the private session created by Popen.
        for pid, _, pgid in table:
            try:
                if os.getsid(pid) == self.process.pid:
                    groups.add(pgid)
                    descendants.add(pid)
            except (ProcessLookupError, PermissionError):
                pass
        groups.add(self.process.pid)
        def live_groups():
            live = set()
            for pid in descendants:
                try:
                    pgid = os.getpgid(pid)
                    if pgid in groups:
                        live.add(pgid)
                except ProcessLookupError:
                    pass
            return live
        def send(sig):
            for pgid in live_groups():
                try:
                    os.killpg(pgid, sig)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    # macOS can return EPERM while a signaled orphan exits.
                    # Ignore only an owned group that has now disappeared;
                    # a permission failure for a still-live group must fail.
                    if pgid in live_groups():
                        raise
        try:
            send(signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            send(signal.SIGKILL)
            self.process.wait(timeout=5)
            def all_gone():
                return not live_groups()
            wait_for(all_gone, 5, "RUNTIME_PROCESS_CLEANUP_FAILED")
            if self.lock_path and self.lock_path.exists():
                # Remove only a new lock whose owner PID is our exact child.
                with self.lock_path.open("r") as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    if stream.read().strip() != str(self.process.pid):
                        raise CheckFailure("RUNTIME_LOCK_OWNER_CHANGED")
                    self.lock_path.unlink()
        finally:
            self.directory.cleanup()
        self.cleaned = True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise CheckFailure("HTTP_REDIRECT_REJECTED")


class Api:
    def __init__(self, base):
        parsed = urlsplit(base)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise CheckFailure("LOCAL_BASE_URL_REQUIRED")
        self.base, self.token = base, None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, method, path, body=None):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                return require_api_success(json.load(response))
        except CheckFailure:
            raise
        except Exception:
            raise CheckFailure("API_TRANSPORT_FAILURE") from None

    def download(self, url, origin):
        validate_download(url, origin)
        try:
            with self.opener.open(urllib.request.Request(url), timeout=20) as response:
                return response.read(4097)
        except CheckFailure:
            raise
        except Exception:
            raise CheckFailure("ARTIFACT_DOWNLOAD_FAILED") from None


def run_scenario(binary, state, base, storage_origin, recommendation, provider="qoder"):
    if not state or not state.is_dir() or state.is_symlink():
        raise CheckFailure("LIFECYCLE_STATE_REQUIRED")
    api = Api(base)
    validate_download(storage_origin, storage_origin)
    evidence = dict(recommendation, verdict="FAIL", checks=[], cleanup=False)
    if provider == "opencode":
        evidence["provider"] = provider
    print(f"RUNTIME_PROVIDER={provider}", flush=True)
    executor_id = None
    owned = None
    try:
        print("RUNTIME_PHASE=CREATE_TEST_OBJECTS", flush=True)
        suffix = secrets.token_hex(8)
        username, password = "runtime-e2e-" + suffix, secrets.token_urlsafe(24)
        api.call("POST", "/api/auth/register", {"username": username, "password": password,
            "email": username + "@example.invalid", "nickname": "Runtime E2E"})
        api.token = api.call("POST", "/api/auth/login", {"username": username, "password": password})["accessToken"]
        workspace_id = api.call("POST", "/api/workspaces", {"name": "Runtime E2E " + suffix})["id"]
        evidence["workspaceId"] = workspace_id
        api.token = api.call("POST", f"/api/workspaces/{workspace_id}/switch")["accessToken"]
        marker = "AW_RUNTIME_PROOF_" + secrets.token_hex(16)
        expected = (marker + "\n").encode()
        instruction = ("This is a bounded smoke test. Use your file/shell tool to create "
            "artifacts/output/deliverables/runtime-proof.txt in the runtime capsule. "
            "Its entire UTF-8 contents must be exactly the following line plus one LF newline: "
            + marker + ". Do not include this sentence's final period in the file. "
            "Read back the file and verify it. Report completion using the runtime output contract. "
            "Do not access credentials, print environment variables, change other files, "
            "or contact external services. No additional tasks are needed.")
        sdlc_id = api.call("POST", "/api/sdlcs", {"name": "Runtime smoke " + suffix,
            "workType": "TASK", "description": "Single deterministic delivery step"})["id"]
        step_id = api.call("POST", f"/api/sdlcs/{sdlc_id}/steps", step_request(instruction))["id"]
        evidence["stepId"] = step_id
        api.call("POST", f"/api/sdlcs/{sdlc_id}/enable", {})
        config = {"roleName": "Runtime Proof", "roleCode": "RUNTIME_E2E",
            "businessBackground": "Run only the assigned bounded local smoke task.",
            "responsibilities": "Follow the SDLC step. Never inspect or emit credentials.",
            "sdlcId": sdlc_id, "evolutionMode": "MANUAL"}
        agent_id = api.call("POST", "/api/agents", dict(config, name="Runtime E2E " + suffix))["id"]
        evidence["agentId"] = agent_id
        api.call("PUT", f"/api/agents/{agent_id}/config", config)
        api.call("POST", f"/api/agents/{agent_id}/submit", {})
        api.call("POST", f"/api/agents/{agent_id}/approve", {"comment": "Disposable runtime smoke"})
        agent = api.call("GET", f"/api/agents/{agent_id}")
        if agent.get("status") != "ONLINE" or not agent.get("onlineVersionId"):
            raise CheckFailure("AGENT_ONLINE_VERSION_REQUIRED")
        evidence["agentVersionId"] = agent["onlineVersionId"]
        executor = reserve_executor(api, agent_id, Path.home() / ".autowonder/run", provider)
        executor_id = evidence["executorId"] = executor["id"]
        connection = {"AUTOWONDER_PROVIDER": provider, "AUTOWONDER_EXECUTOR_ID": str(executor_id),
            "AUTOWONDER_EXECUTOR_TOKEN": executor["token"],
            "AUTOWONDER_SERVER_WS_URL": base.replace("http://", "ws://", 1) + "/ws/executor",
            "AUTOWONDER_DAEMON_ID": "e2e-" + suffix, "AUTOWONDER_RUNTIME_ID": "e2e-" + suffix}
        argv = [str(binary)]
        if provider != "qoder":
            stored_config = api.call("GET", f"/api/executors/{executor_id}/launch-config")
            launch_config = {"version": stored_config["version"], "memoryMode": "none", "maxConcurrentDispatches": 1}
            for key, env_name in (("model", "AW_E2E_EXECUTOR_MODEL"),
                                  ("reasoningEffort", "AW_E2E_EXECUTOR_REASONING_EFFORT")):
                value = os.environ.get(env_name)
                if value:
                    launch_config[key] = value
            api.call("PUT", f"/api/executors/{executor_id}/launch-config", launch_config)
            launch = api.call("POST", f"/api/executors/{executor_id}/launch-command",
                              {"os": "posix", "shell": "bash"})
            argv = local_launch_argv(binary, launch, connection)
            for key, flag in (("model", "--model"), ("reasoningEffort", "--reasoning-effort")):
                if key in launch_config:
                    if argv.count(flag) != 1 or argv[argv.index(flag) + 1:argv.index(flag) + 2] != [launch_config[key]]:
                        raise CheckFailure("LOCAL_EXECUTOR_LAUNCH_COMMAND_INVALID")
                    evidence["checks"].append("generated_launch_" + key)
            evidence["runtimeVersion"] = launch["runtimeVersion"]
            evidence["runtimeRecommendationSource"] = "community-executor"
            evidence["checks"].append("generated_launch_command")
        print("RUNTIME_PHASE=WAIT_ONLINE", flush=True)
        owned = OwnedRuntime(argv, connection, state)
        with owned as process:
            def online():
                if process.poll() is not None:
                    raise CheckFailure("RUNTIME_EXITED")
                return any(e["id"] == executor_id and e.get("status") == "ONLINE"
                    for e in api.call("GET", f"/api/agents/{agent_id}/executors"))
            wait_for(online, 45, "EXECUTOR_ONLINE_TIMEOUT")
            evidence["checks"].append("executor_online")
            workitem_id = api.call("POST", "/api/workitems", {"workType": "TASK",
                "title": "Runtime delivery " + suffix, "contentMd": instruction, "priority": 2})["id"]
            evidence["workitemId"] = workitem_id
            api.call("PUT", f"/api/workitems/{workitem_id}/assignee",
                {"assigneeType": "AGENT", "assigneeRef": agent_id, "sdlcId": sdlc_id})
            print("RUNTIME_PHASE=WAIT_DISPATCH", flush=True)
            def completed():
                if process.poll() is not None:
                    raise CheckFailure("RUNTIME_EXITED")
                rows = api.call("GET", f"/api/dispatches?workitem_id={workitem_id}&page_size=50")["list"]
                if len(rows) > 1:
                    raise CheckFailure("UNEXPECTED_MULTIPLE_DISPATCHES")
                if not rows:
                    return None
                row = rows[0]
                evidence["dispatchId"] = row["id"]
                if row.get("status") in ("FAILED", "TIMEOUT", "CANCELLED"):
                    if provider == "opencode" and row.get("error") in (
                            "OPENCODE_TURN_FAILED", "OPENCODE_VERSION_UNSUPPORTED",
                            "EXECUTOR_CLI_ABORTED", "EXECUTOR_CLI_FAILED",
                            "EXECUTOR_CLI_NOT_FOUND", "EXECUTOR_CLI_OUTPUT_INVALID",
                            "EXECUTOR_CLI_OUTPUT_TOO_LARGE", "EXECUTOR_CLI_START_FAILED",
                            "EXECUTOR_TASK_FAILED", "ARTIFACT_UPLOAD_FAILED",
                            "CAPSULE_DOWNLOAD_FAILED", "CAPSULE_SIGNATURE_INVALID"):
                        evidence["runtimeFailureCode"] = row["error"]
                        print(f"RUNTIME_FAILURE_CODE={row['error']}", flush=True)
                    raise CheckFailure("DISPATCH_TERMINAL_FAILURE")
                return row if row.get("status") == "SUCCEEDED" else None
            dispatch = wait_for(completed, 360, "DISPATCH_TIMEOUT")
            require_dispatch(dispatch, {"workitemId": workitem_id, "agentId": agent_id,
                "agentVersionId": agent["onlineVersionId"], "executorId": executor_id, "sdlcStepId": step_id})
            require_transitions(state / "logs/auto-wonder.log", dispatch["id"])
            evidence["checks"].extend(["routing_matches", "server_acked", "server_running", "dispatch_succeeded"])
            artifact_id = select_artifact(api.call("GET", f"/api/workitems/{workitem_id}/artifacts"), dispatch["id"])
            evidence["artifactId"] = artifact_id
            url = api.call("GET", f"/api/artifacts/{artifact_id}/download")
            evidence["artifactSha256"] = require_artifact(api.download(url, storage_origin), expected)
            evidence["checks"].append("downloaded_artifact_matches")
            # Only EOF diagnostics written during this owned teardown may be attributed.
            evidence["cleanupLogStart"] = log_line_counts(state)
        evidence["verdict"] = "PASS"
    except CheckFailure as exc:
        evidence["failureKind"] = str(exc)
        raise
    except BaseException:
        evidence["failureKind"] = "RUNTIME_CHECK_INTERRUPTED_OR_INTERNAL"
        raise
    finally:
        try:
            if executor_id:
                api.call("DELETE", f"/api/executors/{executor_id}")
            if "cleanupLogStart" in evidence:
                evidence["cleanupLogEnd"] = log_line_counts(state)
            evidence["cleanup"] = owned is None or owned.cleaned
            if not evidence["cleanup"]:
                evidence["verdict"] = "FAIL"
                evidence["failureKind"] = "RUNTIME_CLEANUP_FAILED"
        except Exception:
            evidence["verdict"] = "FAIL"
            evidence["failureKind"] = "EXECUTOR_CLEANUP_FAILED"
        write_evidence(state / "runtime-dispatch.json", evidence)
    if evidence["verdict"] != "PASS":
        raise CheckFailure("EXECUTOR_CLEANUP_FAILED")
    print("RUNTIME_DISPATCH=PASS", flush=True)


def local_launch_argv(binary, launch, connection):
    try:
        argv = shlex.split(launch["command"])
        if len(argv) < 6 or argv[:3] != ["node", "--input-type=module", "--eval"] or argv[4] != "--":
            raise ValueError
        for name, expected in (
            ("--provider", connection["AUTOWONDER_PROVIDER"]),
            ("--executor-id", connection["AUTOWONDER_EXECUTOR_ID"]),
            ("--token", connection["AUTOWONDER_EXECUTOR_TOKEN"]),
            ("--ws-url", connection["AUTOWONDER_SERVER_WS_URL"]),
        ):
            if argv.count(name) != 1 or argv[argv.index(name) + 1] != expected:
                raise ValueError
        if not str(launch["runtimeVersion"]).startswith("community-"):
            raise ValueError
        token_index = argv.index("--token")
        return [str(binary), *argv[1:token_index], *argv[token_index + 2:]]
    except (KeyError, TypeError, ValueError, IndexError):
        raise CheckFailure("LOCAL_EXECUTOR_LAUNCH_COMMAND_INVALID") from None


def require_provider_cli(provider):
    if provider == "qoder":
        if not os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", "").strip():
            raise CheckFailure("QODER_TOKEN_REQUIRED")
        if not shutil.which("qodercli"):
            raise CheckFailure("QODER_CLI_REQUIRED")
        return

    label = provider.upper()
    binary = shutil.which(provider)
    if not binary:
        raise CheckFailure(f"{label}_CLI_REQUIRED")
    if provider == "opencode":
        env = {"PATH": os.environ.get("PATH", ""), **opencode_environment()}
        try:
            with tempfile.TemporaryDirectory(prefix="opencode-preflight-") as directory:
                env.update(HOME=directory, TMPDIR=directory)
                version = subprocess.run([binary, "--version"], env=env, cwd=directory,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, timeout=20)
                match = re.fullmatch(r"(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)",
                                     version.stdout.strip(), re.IGNORECASE)
                if version.returncode or not match:
                    raise CheckFailure("OPENCODE_CLI_VERSION_INVALID")
                if tuple(map(int, match.groups())) < OPENCODE_MIN_VERSION:
                    raise CheckFailure("OPENCODE_VERSION_UNSUPPORTED")
        except (OSError, subprocess.TimeoutExpired):
            raise CheckFailure("OPENCODE_CLI_VERSION_INVALID") from None
        return
    if provider == "codebuddy":
        try:
            version = subprocess.run([binary, "--version"], cwd=None,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, timeout=30)
            match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version.stdout.strip())
            if version.returncode or not match:
                raise CheckFailure("CODEBUDDY_CLI_VERSION_INVALID")
            if tuple(map(int, match.groups())) < CODEBUDDY_MIN_VERSION:
                raise CheckFailure("CODEBUDDY_VERSION_UNSUPPORTED")
        except (OSError, subprocess.TimeoutExpired):
            raise CheckFailure("CODEBUDDY_CLI_VERSION_INVALID") from None
        if not any(os.environ.get(name, "").strip() for name in CODEBUDDY_ENV):
            raise CheckFailure("CODEBUDDY_AUTH_TOKEN_REQUIRED")
        return
    if provider == "claude" and claude_gateway_configured():
        return
    configured_home = os.environ.get(f"AW_E2E_{label}_HOME", "")
    cli_home = Path(configured_home)
    if (not cli_home.is_absolute() or not cli_home.is_dir()
            or cli_home.resolve() == (Path.home() / f".{provider}").resolve()):
        raise CheckFailure(f"{label}_TEST_HOME_REQUIRED")
    home_key = "CODEX_HOME" if provider == "codex" else "CLAUDE_CONFIG_DIR"
    auth_command = "login" if provider == "codex" else "auth"
    try:
        result = subprocess.run([binary, auth_command, "status"],
            env={"PATH": os.environ.get("PATH", ""), "HOME": str(Path.home()), home_key: configured_home},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if result.returncode != 0:
            raise CheckFailure(f"{label}_AUTH_REQUIRED")
    except (OSError, subprocess.TimeoutExpired):
        raise CheckFailure(f"{label}_AUTH_REQUIRED") from None


def preflight(runtime_version=None, provider="qoder", project_root=None):
    require_provider_cli(provider)
    if provider != "qoder":
        root = project_root or Path(__file__).resolve().parents[1]
        node = root / "target/node/node"
        if not node.is_file() or not os.access(node, os.X_OK):
            raise CheckFailure("COMMUNITY_EXECUTOR_NODE_REQUIRED")
        return node.resolve()
    if runtime_version is None:
        runtime_version = source_runtime_version(Path(__file__).resolve().parents[1])
    if not valid_runtime_version(runtime_version):
        raise CheckFailure("RUNTIME_SOURCE_RECOMMENDATION_INVALID")
    package = Path(os.environ.get("AW_E2E_RUNTIME_PACKAGE", ""))
    try:
        metadata = json.loads((package / "package.json").read_text())
    except (OSError, ValueError):
        raise CheckFailure("RUNTIME_PACKAGE_REQUIRED") from None
    if not isinstance(metadata, dict) or metadata.get("name") != "@alicloud/autowonder" or metadata.get("version") != runtime_version:
        raise CheckFailure("RUNTIME_VERSION_MISMATCH")
    system = platform.system().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if system not in ("darwin", "linux") or not arch:
        raise CheckFailure("RUNTIME_PLATFORM_UNSUPPORTED")
    binary = package / "vendor" / f"autowonder-daemon-{system}-{arch}"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise CheckFailure("RUNTIME_BINARY_REQUIRED")
    try:
        # Self-check needs no credentials; never forward the user's token here.
        check = subprocess.run([str(binary.resolve()), "--self-check", "--expected-version", runtime_version],
            env={"PATH": os.environ.get("PATH", "")}, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20)
        identity = json.loads(check.stdout) if check.returncode == 0 else {}
        if not isinstance(identity, dict) or any(identity.get(key) != expected for key, expected in
               (("package", "autowonder"), ("version", runtime_version), ("goos", system), ("goarch", arch))):
            raise CheckFailure("RUNTIME_SELF_CHECK_FAILED")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise CheckFailure("RUNTIME_SELF_CHECK_FAILED") from None
    return binary.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--print-recommended-version", action="store_true")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument("--storage-origin")
    args = parser.parse_args()
    try:
        if args.run and (args.state_dir is None or args.base_url is None or args.storage_origin is None):
            raise CheckFailure("RUNTIME_RECOMMENDATION_CONTEXT_REQUIRED")
        recommendation = resolve_runtime_recommendation(args.project_root, args.state_dir, args.base_url)
        if args.print_recommended_version:
            print(recommendation["runtimeVersion"])
            return 0
        provider = os.environ.get("AW_E2E_RUNTIME_PROVIDER", "qoder")
        if provider not in RUNTIME_CLIENT_KINDS:
            raise CheckFailure("RUNTIME_PROVIDER_UNSUPPORTED")
        binary = preflight(recommendation["runtimeVersion"], provider, args.project_root)
        if args.run:
            run_scenario(binary, args.state_dir, args.base_url, args.storage_origin, recommendation, provider)
            return 0
        print("RUNTIME_PREFLIGHT=PASS")
        return 0
    except CheckFailure as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("RUNTIME_CHECK_INTERNAL_FAILURE", file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise CheckFailure("RUNTIME_CHECK_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
