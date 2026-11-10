import { Freestyle, FreestyleApiError, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REMOTE_AUTOGENERATE_COMMAND = String.raw`
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

nohup /usr/local/bin/npm run autogenerate >>.run/dev.log 2>&1 </dev/null 9>&9 &
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

function getServerConfig(machineParam: string | null): ServerConfig {
  const machine = machineParam?.trim() ?? "";

  if (machine && !/^[1-9]\d*$/.test(machine)) {
    throw new ConfigurationError(
      "machine must be a positive integer, such as 1 or 2.",
    );
  }

  const suffix = machine ? `_${machine}` : "";
  const apiKey = process.env[`FREESTYLE_API_KEY${suffix}`]?.trim();
  const vmId = process.env[`FREESTYLE_VM_ID${suffix}`]?.trim();
  const teamId = process.env[`FREESTYLE_TEAM_ID${suffix}`]?.trim();
  const projectDir =
    process.env[`FREESTYLE_PROJECT_DIR${suffix}`]?.trim() ||
    process.env.FREESTYLE_PROJECT_DIR?.trim() ||
    "/home/ubuntu/freeai-video-deepagent";
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
    machine: machine || "default",
    projectDir,
    linuxUser,
  };
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

async function handleAutogenerate(request: NextRequest) {
  let config: ServerConfig;

  try {
    config = getServerConfig(request.nextUrl.searchParams.get("machine"));
  } catch (error) {
    console.error(
      "Autogenerate route configuration error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      {
        message:
          error instanceof ConfigurationError
            ? error.message
            : "The autogenerate endpoint is not configured correctly.",
        code: "CONFIGURATION_ERROR",
      },
      400,
    );
  }

  const freestyle = new Freestyle({
    apiKey: config.apiKey,
    fetch: uncachedFetch,
  });

  try {
    const current = await freestyle.vms.get(config.vmId);

    // 1. If VM is already running, simply log and do not run the npm command
    if (current.state === "running") {
      console.info("VM is already running. Skipping autogenerate task launch.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: "The VM is already running. Skipping autogenerate task.",
          code: "VM_RUNNING",
          state: current.state,
        },
        200,
      );
    }

    // 2. If VM is starting, log and do not run the npm command
    if (current.state === "starting") {
      console.info("VM is already starting. Skipping autogenerate task launch.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: "The VM is already starting. Skipping autogenerate task.",
          code: "VM_STARTING",
          state: current.state,
        },
        200,
      );
    }

    // 3. If VM is pausing, log and do not run the npm command
    if (current.state === "pausing") {
      console.info("VM is currently pausing. Skipping autogenerate task launch.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: "The VM is currently pausing. Skipping autogenerate task.",
          code: "VM_PAUSING",
          state: current.state,
        },
        200,
      );
    }

    // 4. VM is paused or stopped: start the VM and run the autogenerate task
    console.info("VM is not running. Starting VM for autogenerate.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });

    const vm = freestyle.vms.ref(config.vmId);
    const started = await vm.start();
    await waitUntilRunning(freestyle, config.vmId, started.state);
    await waitUntilGuestReady(vm);

    const result = await execWithRetry(vm, {
      command: REMOTE_AUTOGENERATE_COMMAND,
      env: {
        PROJECT_DIR: config.projectDir,
      },
      linuxUser: config.linuxUser,
      timeoutMs: 30_000,
    });

    if (result.statusCode === 75) {
      console.info("VM process is already running.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      return json(
        { message: "The VM process is already running.", code: "PROCESS_BUSY" },
        200,
      );
    }

    if (result.statusCode === null) {
      return json(
        {
          message:
            "The VM started, but the autogenerate task did not respond in time.",
          code: "LAUNCH_TIMEOUT",
        },
        504,
      );
    }

    if (result.statusCode !== 0) {
      console.error("Autogenerate launcher exited with status", result.statusCode);
      return json(
        {
          message:
            "The VM started, but the autogenerate task could not be launched. Check .run/dev.log on the VM.",
          code: "LAUNCH_FAILED",
        },
        502,
      );
    }

    const pid = result.stdout?.trim();

    if (!pid || !/^\d+$/.test(pid)) {
      console.error("Autogenerate launcher returned an invalid PID.");
      return json(
        {
          message:
            "The VM started, but its launch acknowledgement was invalid.",
          code: "INVALID_ACKNOWLEDGEMENT",
        },
        502,
      );
    }

    console.info("Autogenerate task launched successfully on VM.", {
      machine: config.machine,
      vmId: config.vmId,
      pid,
    });

    return json(
      {
        message:
          "Autogenerate task is running in the background on the VM.",
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
      console.info("VM is already busy (Freestyle API conflict).", {
        machine: config.machine,
        vmId: config.vmId,
      });
      return json(
        { message: "The VM is already busy.", code: "VM_BUSY" },
        200,
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
            "The VM is running but its internal guest services took too long to initialize.",
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
      "Unexpected autogenerate failure:",
      error instanceof Error ? error.name : "unknown error",
    );
    return json(
      {
        message: "An unexpected error prevented the autogenerate task from starting.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}

export async function GET(request: NextRequest) {
  return handleAutogenerate(request);
}

export async function POST(request: NextRequest) {
  return handleAutogenerate(request);
}
