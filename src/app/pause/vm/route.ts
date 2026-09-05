import { Freestyle, FreestyleApiError } from "freestyle";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class ConfigurationError extends Error {}

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

  const freestyle = new Freestyle({ apiKey: config.apiKey });
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

    console.info("Pausing VM.", {
      machine: config.machine,
      vmId: config.vmId,
      state: current.state,
    });
    const paused = await vm.pause();
    console.info("VM pause request accepted.", {
      machine: config.machine,
      vmId: config.vmId,
      state: paused.state,
    });

    return json(
      {
        message: "The VM is being paused.",
        code: "PAUSE_REQUESTED",
        state: paused.state,
      },
      202,
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