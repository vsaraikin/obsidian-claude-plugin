import { execFile } from "child_process";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

let shellEnv: Promise<Record<string, string>> | null = null;

// Printed separately: a proxy set in ~/.zshrc without `export` never reaches `env`.
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/**
 * Obsidian is started from the Dock, so it does not see PATH, proxies or
 * anything else set in ~/.zshrc. Ask the login shell once and cache it.
 */
export function loadShellEnv(): Promise<Record<string, string>> {
  if (shellEnv) return shellEnv;
  const shell = process.env.SHELL || "/bin/zsh";
  shellEnv = new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `echo __CC_ENV_START__; env; ${PROXY_VARS.map((v) => `echo "${v}=$${v}"`).join("; ")}; echo __CC_ENV_END__`],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        const env: Record<string, string> = {};
        const out = stdout ?? "";
        const start = out.indexOf("__CC_ENV_START__");
        const end = out.indexOf("__CC_ENV_END__");
        if (start >= 0 && end > start) {
          for (const line of out.slice(start + "__CC_ENV_START__".length, end).split("\n")) {
            const i = line.indexOf("=");
            const key = line.slice(0, i);
            const value = line.slice(i + 1);
            if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && (value || !(key in env))) env[key] = value;
          }
        }
        resolve(env);
      },
    );
  });
  return shellEnv;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds the `claude` binary; a shell function named claude is skipped on purpose. */
export function findClaude(env: Record<string, string>, configured: string): string | null {
  if (configured.trim()) return isExecutable(configured.trim()) ? configured.trim() : null;
  const home = homedir();
  const dirs = [
    ...(env.PATH ?? process.env.PATH ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Proxy the user's own shell would hand to claude, if any. */
export function detectProxy(env: Record<string, string>): string {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
}

export function buildEnv(shell: Record<string, string>, proxy: string, version: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(shell)) if (v) env[k] = v;
  if (proxy.trim()) {
    env.HTTPS_PROXY = proxy.trim();
    env.HTTP_PROXY = proxy.trim();
    env.NO_PROXY = env.NO_PROXY || "localhost,127.0.0.1";
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `obsidian-agent-sidebar/${version}`;
  return env;
}
