import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function writePodmanStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "podman"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function writeGetenforceStub(binDir: string, mode: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
echo "${mode}"
`;
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "getenforce"), stub, { mode: 0o755 });
}

async function writePodmanInfoRootlessStub(binDir: string, rootless: "true" | "false") {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "info" ]]; then
  echo "${rootless}"
  exit 0
fi
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$DOCKER_STUB_LOG"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$DOCKER_STUB_LOG"
  exit 0
fi
echo "unknown $*" >>"$DOCKER_STUB_LOG"
exit 0
`;
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "podman"), stub, { mode: 0o755 });
}

async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
  const scriptPath = join(rootDir, "docker-setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
  await writeFile(scriptPath, script, { mode: 0o755 });
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    DOCKER_STUB_LOG: sandbox.logPath,
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_WORKSPACE_DIR: join(sandbox.rootDir, "openclaw"),
    ...overrides,
  };
}

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

describe("docker-setup.sh", () => {
  it("handles unset optional env vars under strict mode", async () => {
    const sandbox = await createDockerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: undefined,
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: undefined,
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=");
  });

  it("supports a home volume when extra mounts are empty", async () => {
    const sandbox = await createDockerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const extraCompose = await readFile(join(sandbox.rootDir, "docker-compose.extra.yml"), "utf8");
    expect(extraCompose).toContain("openclaw-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("openclaw-home:");
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);

    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const assocCheck = spawnSync(systemBash, ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status === null || assocCheck.status === 0) {
      return;
    }

    const sandbox = await createDockerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
    });
    const result = spawnSync(systemBash, [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("declare: -A: invalid option");
  });

  it("plumbs OPENCLAW_DOCKER_APT_PACKAGES into .env and docker build args", async () => {
    const sandbox = await createDockerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");

    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("supports Podman compose and writes SELinux bind options", async () => {
    const sandbox = await createDockerSetupSandbox();
    await writePodmanStub(sandbox.binDir, sandbox.logPath);
    await writeGetenforceStub(sandbox.binDir, "Enforcing");
    const env = createEnv(sandbox, {
      OPENCLAW_CONTAINER_ENGINE: "podman",
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: join(sandbox.rootDir, "home"),
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_CONTAINER_ENGINE=podman");
    if (process.platform === "linux") {
      expect(envFile).toContain("OPENCLAW_BIND_MOUNT_OPTIONS=:Z");
      expect(envFile).toMatch(/OPENCLAW_CONTAINER_USER=\d+:\d+/);
    }

    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("compose compose");
    expect(log).toContain("run --rm openclaw-cli onboard --no-install-daemon");
    expect(log).toContain("up -d openclaw-gateway");

    if (process.platform === "linux") {
      const extraCompose = await readFile(join(sandbox.rootDir, "docker-compose.extra.yml"), "utf8");
      expect(extraCompose).toContain(":/home/node:Z");
      expect(extraCompose).toContain(":/home/node/.openclaw:Z");
      expect(extraCompose).toMatch(/user: "\d+:\d+"/);
    }
  });

  it("writes a user-only extra compose file without empty volumes keys", async () => {
    const sandbox = await createDockerSetupSandbox();
    await writePodmanStub(sandbox.binDir, sandbox.logPath);
    await writeGetenforceStub(sandbox.binDir, "Enforcing");
    const env = createEnv(sandbox, {
      OPENCLAW_CONTAINER_ENGINE: "podman",
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
      OPENCLAW_BIND_MOUNT_OPTIONS: "",
      OPENCLAW_CONTAINER_USER: "1001:1001",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const extraCompose = await readFile(join(sandbox.rootDir, "docker-compose.extra.yml"), "utf8");
    expect(extraCompose).toContain('user: "1001:1001"');
    expect(extraCompose).not.toMatch(/^\s+volumes:\s*$/m);
  });

  it("defaults to user 0:0 for rootless Podman on Linux", async () => {
    const sandbox = await createDockerSetupSandbox();
    await writePodmanInfoRootlessStub(sandbox.binDir, "true");
    await writeGetenforceStub(sandbox.binDir, "Enforcing");
    const env = createEnv(sandbox, {
      OPENCLAW_CONTAINER_ENGINE: "podman",
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
      OPENCLAW_BIND_MOUNT_OPTIONS: "",
      OPENCLAW_CONTAINER_USER: "",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    if (process.platform === "linux") {
      const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
      expect(envFile).toContain("OPENCLAW_CONTAINER_USER=0:0");
      const extraCompose = await readFile(join(sandbox.rootDir, "docker-compose.extra.yml"), "utf8");
      expect(extraCompose).toContain('user: "0:0"');
    }
  });
});
