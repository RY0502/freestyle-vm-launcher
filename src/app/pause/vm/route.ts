import { Freestyle, FreestyleApiError, type Vm, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class ConfigurationError extends Error {}
class VmPauseTimeoutError extends Error {}

const MAX_PAUSE_ATTEMPTS = 3;

const REMOTE_FORCE_STOP_COMMAND = [
  "set -u",
  'PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/freeai-video-deepagent}"',
  'if [ -d "$PROJECT_DIR" ]; then',
  '  cd "$PROJECT_DIR" || true',
  '  if [ -s .run/dev.pid ]; then',
  '    PID="$(cat .run/dev.pid 2>/dev/null || true)"',
  '    case "$PID" in',
  '      ""|*[!0-9]*)',
  "        ;;",
  "      *)",
  '        pkill -9 -P "$PID" 2>/dev/null || true',
  '        kill -9 "$PID" 2>/dev/null || true',
  "        ;;",
  "    esac",
  "    rm -f .run/dev.pid",
  "  fi",
  "  rm -f .run/dev.lock",
  "fi",
  'pkill -9 -f "npm run dev" 2>/dev/null || true',
  'pkill -9 -f "python" 2>/dev/null || true',
  "sync",
].join("\n");

type ServerConfig = {
  apiKey: string;
  vmId: string;
  teamId: string;
  machine: string;
  projectDir: string;
  linuxUser?: string;
};

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

  return {
    apiKey: apiKey!,
    vmId: vmId!,
    teamId: teamId!,
    machine: machine || "default",
    projectDir,
    linuxUser,
  };
}

function uncachedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

async function terminateGuestWorkload(vm: Vm, config: ServerConfig) {
  try {
    console.info("Executing in-guest force-stop before pause.", {
      machine: config.machine,
      vmId: config.vmId,
    });
    const scopedVm = config.linuxUser ? vm.linuxUser(config.linuxUser) : vm;
    await scopedVm.exec({
      command: `/bin/sh -c '${REMOTE_FORCE_STOP_COMMAND.replace(/'/g, "'\\''")}'`,
      env: { PROJECT_DIR: config.projectDir },
      timeoutMs: 5000,
    });
    console.info("In-guest force-stop completed.", {
      machine: config.machine,
      vmId: config.vmId,
    });
  } catch (error) {
    console.warn("In-guest force-stop encountered an error; proceeding with pause.", {
      machine: config.machine,
      vmId: config.vmId,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function pauseWithRetry(vm: Vm, machine: string, vmId: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PAUSE_ATTEMPTS; attempt += 1) {
    try {
      return await vm.pause();
    } catch (error) {
      lastError = error;

      if (attempt === MAX_PAUSE_ATTEMPTS) break;

      console.warn("Freestyle pause attempt failed; retrying.", {
        machine,
        vmId,
        attempt,
        nextAttempt: attempt + 1,
        error: error instanceof Error ? error.message : "unknown error",
      });
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastError;
}

async function waitForBootCompletion(
  freestyle: Freestyle,
  vmId: string,
): Promise<VmState> {
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = await freestyle.vms.get(vmId);
    if (current.state !== "starting") {
      return current.state;
    }
  }

  return "starting";
}

async function waitUntilPaused(
  freestyle: Freestyle,
  vm: Vm,
  vmId: string,
  initialState: VmState,
) {
  if (initialState === "paused") return;

  const startTime = Date.now();
  const deadline = startTime + 45_000;
  let retriggered = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = await freestyle.vms.get(vmId);

    if (current.state === "paused" || current.state === "stopped") {
      return;
    }

    // If VM is still reporting "running" after 4s, re-trigger pause once to ensure the command was received
    if (
      current.state === "running" &&
      Date.now() - startTime > 4000 &&
      !retriggered
    ) {
      retriggered = true;
      try {
        console.info("VM still running after 4s; re-issuing pause.", { vmId });
        await vm.pause();
      } catch (error) {
        console.warn(
          "Re-issued pause error:",
          error instanceof Error ? error.message : "unknown error",
        );
      }
    }

    // Accept both "pausing" and "running" as in-progress states
    if (current.state !== "pausing" && current.state !== "running") {
      throw new VmPauseTimeoutError(
        `VM entered the unexpected state "${current.state}".`,
      );
    }
  }

  throw new VmPauseTimeoutError("VM did not become paused in time.");
}

export async function GET(request: NextRequest) {
  let config: ServerConfig;

  try {
    config = getServerConfig(request.nextUrl.searchParams.get("machine"));
  } catch (error) {
    console.error(
      "Pause route configuration error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      {
        message:
          error instanceof ConfigurationError
            ? error.message
            : "The pause endpoint is not configured correctly.",
        code: "CONFIGURATION_ERROR",
      },
      error instanceof ConfigurationError &&
      error.message.startsWith("machine")
        ? 400
        : 503,
    );
  }

  const freestyle = new Freestyle({
    apiKey: config.apiKey,
    fetch: uncachedFetch,
  });
  const vm = freestyle.vms.ref(config.vmId);

  try {
    let current = await freestyle.vms.get(config.vmId);
    console.info("Pause request checked VM state.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });

    if (current.state === "paused") {
      console.info("Pause request made no change; VM is already paused.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: "The VM is already paused.",
          code: "ALREADY_PAUSED",
          state: current.state,
        },
        200,
      );
    }

    if (current.state === "pausing") {
      console.info("VM is already pausing; waiting for paused state.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      await waitUntilPaused(freestyle, vm, config.vmId, current.state);
      const final = await freestyle.vms.get(config.vmId);
      return json(
        {
          message: "The VM is paused.",
          code: "PAUSED",
          state: final.state,
        },
        200,
      );
    }

    if (current.state === "starting") {
      console.info("VM is currently starting; waiting for boot to finish.", {
        machine: config.machine,
        vmId: config.vmId,
      });
      const stateAfterBoot = await waitForBootCompletion(freestyle, config.vmId);
      if (stateAfterBoot === "paused") {
        return json(
          {
            message: "The VM is already paused.",
            code: "ALREADY_PAUSED",
            state: stateAfterBoot,
          },
          200,
        );
      }
      current = await freestyle.vms.get(config.vmId);
    }

    if (current.state !== "running") {
      console.info("Pause request rejected because VM is not running.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: `The VM is ${current.state} and cannot be paused right now.`,
          code: "VM_NOT_RUNNING",
          state: current.state,
        },
        409,
      );
    }

    // Force-stop in-guest rendering processes to release CPU and stop dirtying RAM
    await terminateGuestWorkload(vm, config);

    console.info("Pausing VM.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });
    const paused = await pauseWithRetry(vm, config.machine, config.vmId);
    console.info("Freestyle pause call succeeded.", {
      machine: config.machine,
      vmId: config.vmId,
      state: paused.state,
    });

    await waitUntilPaused(freestyle, vm, config.vmId, paused.state);
    const final = await freestyle.vms.get(config.vmId);
    console.info("VM status after pause call succeeded.", {
      machine: config.machine,
      vmId: config.vmId,
      state: final.state,
    });

    return json(
      {
        message: "The VM is paused.",
        code: "PAUSED",
        state: final.state,
      },
      200,
    );
  } catch (error) {
    if (error instanceof FreestyleApiError) {
      console.error("Freestyle pause request failed.", {
        machine: config.machine,
        vmId: config.vmId,
        status: error.status,
        code: error.code,
        path: error.path,
      });
      return json(
        {
          message: "Freestyle could not pause the VM. Please try again later.",
          code: "FREESTYLE_ERROR",
        },
        502,
      );
    }

    if (error instanceof VmPauseTimeoutError) {
      console.error("Freestyle pause request did not reach paused state.", {
        machine: config.machine,
        vmId: config.vmId,
        message: error.message,
      });
      return json(
        {
          message:
            "The pause request was sent, but Freestyle did not confirm that the VM is paused yet.",
          code: "PAUSE_NOT_CONFIRMED",
        },
        504,
      );
    }

    console.error(
      "Unexpected pause failure:",
      error instanceof Error ? error.name : "unknown error",
    );
    return json(
      {
        message: "An unexpected error prevented the VM from being paused.",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  }
}