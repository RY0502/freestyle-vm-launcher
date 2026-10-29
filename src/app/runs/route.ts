import { Freestyle, FreestyleApiError, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUSY_MESSAGE =
  "The VM is already running. Try back again in some time.";

const REMOTE_DEV_COMMAND = String.raw`
set -u
cd "$PROJECT_DIR" || exit 72
umask 077
mkdir -p .run
exec 9>.run/dev.lock
/usr/bin/flock -n 9 || {
  printf 'ALREADY_RUNNING\n' >&2
  exit 75
}

old_pid=""
if [ -s .run/dev.pid ]; then
  old_pid="$(cat .run/dev.pid 2>/dev/null || true)"
fi

case "$old_pid" in
  ""|*[!0-9]*)
    ;;
  *)
    if kill -0 "$old_pid" 2>/dev/null; then
      printf 'ALREADY_RUNNING\n' >&2
      exit 75
    fi
    ;;
esac

nohup /usr/local/bin/npm run dev >>.run/dev.log 2>&1 </dev/null 9>&9 &
pid=$!
printf '%s\n' "$pid" >.run/dev.pid
printf '%s\n' "$pid"
`.trim();

type ServerConfig = {
  apiKey: string;
  vmId: string;
  teamId: string;
  machine: string;
  projectDir: string;
  allowedOrigin?: string;
  linuxUser?: string;
};

class ConfigurationError extends Error {}
class VmStartTimeoutError extends Error {}
class GuestNotReadyError extends Error {}

function json(
  body: Record<string, unknown>,
  status: number,
  headers: HeadersInit = {},
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function uncachedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

function getServerConfig(machineParam?: string | null): ServerConfig {
  const machine = machineParam?.trim() || "1";

  if (!/^[1-9]\d*$/.test(machine)) {
    throw new ConfigurationError(
      "machine must be a positive integer, such as 1 or 2.",
    );
  }

  const suffix = `_${machine}`;
  const apiKey = process.env[`FREESTYLE_API_KEY${suffix}`]?.trim();
  const vmId = process.env[`FREESTYLE_VM_ID${suffix}`]?.trim();
  const teamId = process.env[`FREESTYLE_TEAM_ID${suffix}`]?.trim();
  const projectDir =
    process.env[`FREESTYLE_PROJECT_DIR${suffix}`]?.trim() ||
    process.env.FREESTYLE_PROJECT_DIR?.trim() ||
    "/home/ubuntu/content-generator-video";
  const allowedOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  const linuxUser = process.env.FREESTYLE_LINUX_USER?.trim();

  const missing = [
    !apiKey && `FREESTYLE_API_KEY${suffix}`,
    !vmId && `FREESTYLE_VM_ID${suffix}`,
    !teamId && `FREESTYLE_TEAM_ID${suffix}`,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing server environment variables: ${missing.join(", ")}`,
    );
  }

  if (!projectDir.startsWith("/")) {
    throw new ConfigurationError(
      "FREESTYLE_PROJECT_DIR must be an absolute path.",
    );
  }

  if (linuxUser && !/^[a-z_][a-z0-9_-]*[$]?$/i.test(linuxUser)) {
    throw new ConfigurationError("FREESTYLE_LINUX_USER is invalid.");
  }

  return {
    apiKey: apiKey!,
    vmId: vmId!,
    teamId: teamId!,
    machine,
    projectDir,
    allowedOrigin,
    linuxUser,
  };
}

function hasAllowedOrigin(request: NextRequest, configuredOrigin?: string) {
  const origin = request.headers.get("origin");

  if (!origin) return true;

  try {
    const receivedOrigin = new URL(origin).origin;
    const expectedOrigin = configuredOrigin
      ? new URL(configuredOrigin).origin
      : request.nextUrl.origin;

    return receivedOrigin === expectedOrigin;
  } catch {
    return false;
  }
}

async function waitUntilRunning(
  freestyle: Freestyle,
  vmId: string,
  initialState: VmState,
) {
  if (initialState === "running") return;

  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const current = await freestyle.vms.get(vmId);

    if (current.state === "running") return;

    if (current.state === "stopped" || current.state === "pausing") {
      throw new VmStartTimeoutError(
        `VM entered the unexpected state "${current.state}".`,
      );
    }
  }

  throw new VmStartTimeoutError("VM did not become ready in time.");
}

async function waitUntilGuestReady(
  vm: ReturnType<Freestyle["vms"]["ref"]>,
  timeoutMs = 50_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  await new Promise((resolve) => setTimeout(resolve, 1500));

  while (Date.now() < deadline) {
    try {
      await vm.fs.writeTextFile("/tmp/.guest_ready_probe", String(Date.now()), {
        signal: AbortSignal.timeout(3500),
      });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new GuestNotReadyError(
    `VM guest agent did not become ready within ${Math.round(timeoutMs / 1000)}s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function execWithRetry(
  vm: ReturnType<Freestyle["vms"]["ref"]>,
  options: Parameters<ReturnType<Freestyle["vms"]["ref"]>["exec"]>[0],
  maxRetries = 3,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await vm.exec(options);
    } catch (err) {
      lastError = err;
      const is502 =
        err instanceof FreestyleApiError &&
        (err.status === 502 || err.code === "INTERNAL_ERROR");
      if (is502 && attempt < maxRetries) {
        console.warn(
          `vm.exec received 502, retrying in 3s (attempt ${attempt}/${maxRetries})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function POST(request: NextRequest) {
  let config: ServerConfig;

  try {
    const machineParam = request.nextUrl.searchParams.get("machine");
    config = getServerConfig(machineParam);
  } catch (error) {
    console.error(
      "Runs route configuration error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      {
        message:
          error instanceof ConfigurationError
            ? error.message
            : "The runs endpoint is not configured correctly.",
      },
      503,
    );
  }

  if (!hasAllowedOrigin(request, config.allowedOrigin)) {
    return json({ message: "This request origin is not allowed." }, 403);
  }

  const freestyle = new Freestyle({
    apiKey: config.apiKey,
    fetch: uncachedFetch,
  });

  try {
    const current = await freestyle.vms.get(config.vmId);

    if (current.state === "pausing") {
      return json(
        {
          message:
            "The VM is currently pausing. Please wait a moment and try again.",
          code: "VM_PAUSING",
          state: current.state,
        },
        409,
        { "Retry-After": "10" },
      );
    }

    const vm = freestyle.vms.ref(config.vmId);

    if (current.state === "starting") {
      console.info("VM is starting, waiting until running.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      await waitUntilRunning(freestyle, config.vmId, current.state);
    } else if (current.state !== "running") {
      console.info("Starting VM.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      const started = await vm.start();
      await waitUntilRunning(freestyle, config.vmId, started.state);
    } else {
      console.info(
        "VM is already running. Ensuring guest agent readiness and process.",
        {
          machine: config.machine,
          vmId: config.vmId,
        },
      );
    }

    await waitUntilGuestReady(vm);

    const result = await execWithRetry(vm, {
      command: REMOTE_DEV_COMMAND,
      env: {
        PROJECT_DIR: config.projectDir,
      },
      linuxUser: config.linuxUser,
      timeoutMs: 30_000,
    });

    if (result.statusCode === 75) {
      return json(
        { message: BUSY_MESSAGE, code: "PROCESS_BUSY" },
        409,
        { "Retry-After": "30" },
      );
    }

    if (result.statusCode === null) {
      return json(
        {
          message:
            "The VM started, but the task launcher did not respond in time. Check the VM log before trying again.",
          code: "LAUNCH_TIMEOUT",
        },
        504,
      );
    }

    if (result.statusCode !== 0) {
      console.error("Remote launcher exited with status", result.statusCode);
      return json(
        {
          message:
            "The VM started, but the task could not be launched. Check .run/dev.log on the VM.",
          code: "LAUNCH_FAILED",
        },
        502,
      );
    }

    const pid = result.stdout?.trim();

    if (!pid || !/^\d+$/.test(pid)) {
      console.error("Remote launcher returned an invalid PID.");
      return json(
        {
          message:
            "The VM started, but its launch acknowledgement was invalid. Check the VM before trying again.",
          code: "INVALID_ACKNOWLEDGEMENT",
        },
        502,
      );
    }

    return json(
      {
        message:
          "Your dev task is running in the background.",
        code: "LAUNCHED",
        job: {
          pid,
          logPath: `${config.projectDir}/.run/dev.log`,
        },
      },
      202,
    );
  } catch (error) {
    if (
      error instanceof FreestyleApiError &&
      (error.status === 409 || error.code === "CONFLICT")
    ) {
      return json(
        { message: BUSY_MESSAGE, code: "VM_BUSY" },
        409,
        { "Retry-After": "30" },
      );
    }

    if (error instanceof VmStartTimeoutError) {
      console.error("VM start timed out.");
      return json(
        {
          message:
            "The VM is still starting. Check its status before trying again.",
          code: "VM_START_TIMEOUT",
        },
        504,
      );
    }

    if (error instanceof GuestNotReadyError) {
      console.error("VM guest agent timed out:", error.message, {
        machine: config.machine,
        vmId: config.vmId,
      });
      return json(
        {
          message:
            "The VM is running but its internal guest services took too long to initialize. Please try again shortly.",
          code: "GUEST_NOT_READY",
        },
        504,
      );
    }

    if (error instanceof FreestyleApiError) {
      console.error("Freestyle API request failed.", {
        status: error.status,
        code: error.code,
        path: error.path,
      });
      return json(
        {
          message:
            "Freestyle could not complete the VM request. Please try again later.",
          code: "FREESTYLE_ERROR",
        },
        502,
      );
    }

    console.error(
      "Unexpected launch failure:",
      error instanceof Error ? error.name : "unknown error",
    );
    return json(
      {
        message: "An unexpected error prevented the task from starting.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}
