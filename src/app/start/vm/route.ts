import { Freestyle, FreestyleApiError, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REMOTE_START_COMMAND = String.raw`
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

nohup /usr/local/bin/npm run dev prompt.txt >>.run/dev.log 2>&1 </dev/null 9>&9 &
pid=$!
printf '%s\n' "$pid" >.run/dev.pid
printf '%s\n' "$pid"
`.trim();

class ConfigurationError extends Error {}
class VmStartTimeoutError extends Error {}

type ServerConfig = {
  apiKey: string;
  vmId: string;
  teamId: string;
  machine: string;
  projectDir: string;
  linuxUser?: string;
};

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

function getServerConfig(machineParam: string | null): ServerConfig {
  const machine = machineParam?.trim() ?? "";

  if (!machine || !/^[1-9]\d*$/.test(machine)) {
    throw new ConfigurationError(
      "machine is required and must be a positive integer, such as 1 or 2.",
    );
  }

  const suffix = `_${machine}`;
  const apiKey = process.env[`FREESTYLE_API_KEY${suffix}`]?.trim();
  const vmId = process.env[`FREESTYLE_VM_ID${suffix}`]?.trim();
  const teamId = process.env[`FREESTYLE_TEAM_ID${suffix}`]?.trim();
  const projectDir = process.env[`FREESTYLE_PROJECT_DIR${suffix}`]?.trim();
  const linuxUser = process.env.FREESTYLE_LINUX_USER?.trim();

  const missing = [
    !apiKey && `FREESTYLE_API_KEY${suffix}`,
    !vmId && `FREESTYLE_VM_ID${suffix}`,
    !teamId && `FREESTYLE_TEAM_ID${suffix}`,
    !projectDir && `FREESTYLE_PROJECT_DIR${suffix}`,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing server environment variables: ${missing.join(", ")}`,
    );
  }

  if (!projectDir!.startsWith("/")) {
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
    projectDir: projectDir!,
    linuxUser,
  };
}

function isActiveState(state: VmState) {
  return state === "running" || state === "starting" || state === "pausing";
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

export async function GET(request: NextRequest) {
  let config: ServerConfig;

  try {
    config = getServerConfig(request.nextUrl.searchParams.get("machine"));
  } catch (error) {
    console.error(
      "Start route configuration error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      {
        message:
          error instanceof ConfigurationError
            ? error.message
            : "The start endpoint is not configured correctly.",
        code: "CONFIGURATION_ERROR",
      },
      400,
    );
  }

  const freestyle = new Freestyle({ apiKey: config.apiKey });
  const vm = freestyle.vms.ref(config.vmId);

  try {
    const current = await freestyle.vms.get(config.vmId);
    console.info("Start request checked VM state.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });

    if (isActiveState(current.state)) {
      console.info("Start request made no change; VM is already active.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message:
            current.state === "running"
              ? "The VM is already running."
              : "The VM is already starting.",
          code: current.state === "running" ? "ALREADY_RUNNING" : "START_IN_PROGRESS",
          state: current.state,
        },
        200,
      );
    }

    console.info("Starting VM.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });
    const started = await vm.start();
    await waitUntilRunning(freestyle, config.vmId, started.state);

    const result = await vm.exec({
      command: REMOTE_START_COMMAND,
      env: { PROJECT_DIR: config.projectDir },
      linuxUser: config.linuxUser,
      timeoutMs: 30_000,
    });

    if (result.statusCode === 75) {
      console.info("VM was started, but its process is already running.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      return json(
        { message: "The VM is already running.", code: "PROCESS_RUNNING" },
        200,
      );
    }

    if (result.statusCode === null) {
      return json(
        {
          message:
            "The VM started, but the process launcher did not respond in time.",
          code: "START_TIMEOUT",
        },
        504,
      );
    }

    if (result.statusCode !== 0) {
      console.error("Remote start command exited with status", result.statusCode);
      return json(
        {
          message: "The VM started, but the process could not be launched.",
          code: "START_FAILED",
        },
        502,
      );
    }

    const pid = result.stdout?.trim();
    console.info("VM started and process launched.", {
      machine: config.machine,
      vmId: config.vmId,
      pid,
    });

    return json(
      {
        message: "The VM started and the process is running in the background.",
        code: "STARTED",
        state: "running",
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
        { message: "The VM is already starting or running.", code: "VM_BUSY" },
        200,
      );
    }

    if (error instanceof VmStartTimeoutError) {
      console.error("VM start timed out.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      return json(
        {
          message: "The VM is still starting. Check its status before retrying.",
          code: "VM_START_TIMEOUT",
        },
        504,
      );
    }

    if (error instanceof FreestyleApiError) {
      console.error("Freestyle start request failed.", {
        machine: config.machine,
        vmId: config.vmId,
        status: error.status,
        code: error.code,
        path: error.path,
      });
      return json(
        {
          message: "Freestyle could not start the VM. Please try again later.",
          code: "FREESTYLE_ERROR",
        },
        502,
      );
    }

    console.error(
      "Unexpected start failure:",
      error instanceof Error ? error.name : "unknown error",
    );
    return json(
      {
        message: "An unexpected error prevented the VM from starting.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}