import { Freestyle, FreestyleApiError, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class ConfigurationError extends Error {}
class VmPauseTimeoutError extends Error {}

const MAX_PAUSE_ATTEMPTS = 3;

type ServerConfig = {
  apiKey: string;
  vmId: string;
  teamId: string;
  machine: string;
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
  };
}

function uncachedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

type PauseableVm = {
  pause: () => Promise<{ state: VmState }>;
};

async function pauseWithRetry(vm: PauseableVm, machine: string, vmId: string) {
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

async function waitUntilPaused(
  freestyle: Freestyle,
  vmId: string,
  initialState: VmState,
) {
  if (initialState === "paused") return;

  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const current = await freestyle.vms.get(vmId);

    if (current.state === "paused") return;

    if (current.state !== "pausing") {
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
    const current = await freestyle.vms.get(config.vmId);
    console.info("Pause request checked VM state.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });

    if (current.state === "paused" || current.state === "pausing") {
      console.info(
        "Pause request made no change; VM is already paused or pausing.",
        {
          machine: config.machine,
          vmId: config.vmId,
          state: current.state,
        },
      );
      return json(
        {
          message:
            current.state === "paused"
              ? "The VM is already paused."
              : "The VM is already being paused.",
          code:
            current.state === "paused"
              ? "ALREADY_PAUSED"
              : "PAUSE_IN_PROGRESS",
          state: current.state,
        },
        200,
      );
    }

    if (current.state !== "running") {
      console.info("Pause request rejected because VM is not running.", {
        machine: config.machine,
        vmId: config.vmId,
        state: current.state,
      });
      return json(
        {
          message: "The VM is not running and cannot be paused right now.",
          code: "VM_NOT_RUNNING",
          state: current.state,
        },
        409,
      );
    }

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
    await waitUntilPaused(freestyle, config.vmId, paused.state);
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