import { Freestyle, FreestyleApiError, type VmState } from "freestyle";
import { NextRequest, NextResponse } from "next/server";
import {
  clearExistingInputFiles,
  formatReferenceUrls,
  uploadInputImages,
  type UploadedImageInput,
} from "@/lib/supabaseStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUSY_MESSAGE =
  "The VM is already running. Try back again in some time.";

const REMOTE_LAUNCH_COMMAND = String.raw`
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

if [ "$PERFORM_CLEANUP" = "1" ]; then
  USER_PROMPT="${"$"}{USER_PROMPT}. Perform cleanup after successful load."
fi

set -- "$USER_PROMPT"

if [ "$YOUTUBE_UPLOAD" = "1" ]; then
  set -- --youtube "$@"
fi

nohup /usr/local/bin/npm run dev -- "$@" >>.run/dev.log 2>&1 </dev/null 9>&9 &
pid=$!
printf '%s\n' "$pid" >.run/dev.pid
printf '%s\n' "$pid"
`.trim();

type LaunchRequestBody = {
  prompt?: unknown;
  youtube?: unknown;
  cleanup?: unknown;
  images?: unknown;
};

type ServerConfig = {
  apiKey: string;
  vmId: string;
  teamId: string;
  projectDir: string;
  allowedOrigin?: string;
  linuxUser?: string;
};

class ConfigurationError extends Error { }
class VmStartTimeoutError extends Error { }
class GuestNotReadyError extends Error { }

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

function getServerConfig(): ServerConfig {
  const apiKey = process.env.FREESTYLE_API_KEY?.trim();
  const vmId = process.env.FREESTYLE_VM_ID?.trim();
  const teamId = process.env.FREESTYLE_TEAM_ID?.trim();
  const projectDir =
    process.env.FREESTYLE_PROJECT_DIR?.trim() ??
    "/home/ubuntu/freeai-video-deepagent";
  const allowedOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  const linuxUser = process.env.FREESTYLE_LINUX_USER?.trim();

  const missing = [
    !apiKey && "FREESTYLE_API_KEY",
    !vmId && "FREESTYLE_VM_ID",
    !teamId && "FREESTYLE_TEAM_ID",
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
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

  if (
    linuxUser &&
    !/^[a-z_][a-z0-9_-]*[$]?$/i.test(linuxUser)
  ) {
    throw new ConfigurationError("FREESTYLE_LINUX_USER is invalid.");
  }

  return {
    apiKey: apiKey!,
    vmId: vmId!,
    teamId: teamId!,
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

function validatePrompt(prompt: unknown) {
  if (typeof prompt !== "string") {
    return { error: "Enter a prompt before starting the studio." } as const;
  }

  const value = prompt.trim();

  if (!value) {
    return { error: "Enter a prompt before starting the studio." } as const;
  }

  if (value.length > 4_000 || Buffer.byteLength(value, "utf8") > 12_000) {
    return { error: "Keep the prompt under 4,000 characters." } as const;
  }

  if (value.includes("\0")) {
    return { error: "The prompt contains an unsupported character." } as const;
  }

  return { value } as const;
}

function isBusyState(state: VmState) {
  return state === "running" || state === "starting" || state === "pausing";
}

function validateOption(value: unknown, name: string) {
  if (typeof value !== "boolean") {
    return { error: `${name} must be a boolean.` } as const;
  }

  return { value } as const;
}

function uncachedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
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
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  await new Promise((resolve) => setTimeout(resolve, 1500));

  while (Date.now() < deadline) {
    try {
      await vm.fs.writeTextFile("/tmp/.guest_ready_probe", String(Date.now()));
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
  const contentType = request.headers.get("content-type") || "";
  const isMultipart = contentType.includes("multipart/form-data");
  const isJson = contentType.includes("application/json");

  if (!isMultipart && !isJson) {
    return json(
      { message: "Content-Type must be application/json or multipart/form-data." },
      415
    );
  }

  let config: ServerConfig;

  try {
    config = getServerConfig();
  } catch (error) {
    console.error(
      "Launch route configuration error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      { message: "The studio is not configured yet. Contact the site owner." },
      503,
    );
  }

  if (!hasAllowedOrigin(request, config.allowedOrigin)) {
    return json({ message: "This request origin is not allowed." }, 403);
  }

  let rawPrompt: unknown;
  let rawYoutube: unknown;
  let rawCleanup: unknown;
  const imagesToUpload: UploadedImageInput[] = [];

  if (isMultipart) {
    try {
      const formData = await request.formData();
      rawPrompt = formData.get("prompt");
      const ytVal = formData.get("youtube");
      rawYoutube = ytVal === "true" || ytVal === "1";
      const cleanVal = formData.get("cleanup");
      rawCleanup = cleanVal === "true" || cleanVal === "1";

      const rawFiles = [
        ...formData.getAll("images"),
        ...formData.getAll("files"),
      ];

      const files = rawFiles.filter(
        (f) => f instanceof File && f.size > 0
      ) as File[];

      if (files.length > 5) {
        return json({ message: "You can upload a maximum of 5 images." }, 400);
      }

      for (const file of files) {
        if (
          !file.type.startsWith("image/") &&
          !file.name.match(/\.(jpe?g|png|webp|gif|bmp|avif)$/i)
        ) {
          return json(
            { message: `File "${file.name}" is not a supported image file.` },
            400
          );
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        imagesToUpload.push({
          name: file.name,
          type: file.type || "image/png",
          data: buffer,
        });
      }
    } catch {
      return json({ message: "Failed to parse multipart form data." }, 400);
    }
  } else {
    let body: LaunchRequestBody;
    try {
      body = (await request.json()) as LaunchRequestBody;
    } catch {
      return json({ message: "The request body must be valid JSON." }, 400);
    }

    rawPrompt = body.prompt;
    rawYoutube = body.youtube;
    rawCleanup = body.cleanup;

    if (Array.isArray(body.images)) {
      if (body.images.length > 5) {
        return json({ message: "You can upload a maximum of 5 images." }, 400);
      }
      for (const item of body.images) {
        if (item && typeof item === "object" && "base64" in item) {
          const imgObj = item as { name?: string; type?: string; base64: string };
          imagesToUpload.push({
            name: imgObj.name || `image_${imagesToUpload.length + 1}.png`,
            type: imgObj.type || "image/png",
            data: Buffer.from(imgObj.base64, "base64"),
          });
        }
      }
    }
  }

  const validatedPrompt = validatePrompt(rawPrompt);

  if ("error" in validatedPrompt) {
    return json({ message: validatedPrompt.error }, 400);
  }

  const validatedYoutube = validateOption(rawYoutube, "youtube");
  const validatedCleanup = validateOption(rawCleanup, "cleanup");

  if ("error" in validatedYoutube) {
    return json({ message: validatedYoutube.error }, 400);
  }

  if ("error" in validatedCleanup) {
    return json({ message: validatedCleanup.error }, 400);
  }

  const freestyle = new Freestyle({
    apiKey: config.apiKey,
    fetch: uncachedFetch,
  });

  try {
    const current = await freestyle.vms.get(config.vmId);

    if (isBusyState(current.state)) {
      return json(
        { message: BUSY_MESSAGE, code: "VM_BUSY" },
        409,
        { "Retry-After": "30" },
      );
    }

    if (current.state !== "paused") {
      return json(
        {
          message:
            "The VM is not paused and cannot accept a new task right now.",
          code: "VM_NOT_PAUSED",
        },
        409,
        { "Retry-After": "30" },
      );
    }

    const vm = freestyle.vms.ref(config.vmId);
    const started = await vm.start();

    await waitUntilRunning(freestyle, config.vmId, started.state);

    // 1. Clear existing image files in Supabase 'input' directory at each submission request
    try {
      await clearExistingInputFiles();
    } catch (clearError) {
      console.error("Failed to clear Supabase input directory:", clearError);
      return json(
        {
          message:
            clearError instanceof Error
              ? clearError.message
              : "Failed to clear existing files in Supabase storage.",
          code: "STORAGE_CLEAR_FAILED",
        },
        502,
      );
    }

    // 2. If uploaded images are there, upload to 'input' directory in the Supabase bucket
    let referenceUrls: string[] = [];
    if (imagesToUpload.length > 0) {
      try {
        referenceUrls = await uploadInputImages(imagesToUpload);
      } catch (uploadError) {
        console.error("Failed to upload images to Supabase storage:", uploadError);
        return json(
          {
            message:
              uploadError instanceof Error
                ? uploadError.message
                : "Failed to upload reference images to Supabase storage.",
            code: "STORAGE_UPLOAD_FAILED",
          },
          502,
        );
      }
    }

    // 3. Append reference URLs before the perform cleanup text of the prompt
    let userPromptWithReferences = validatedPrompt.value;
    if (referenceUrls.length > 0) {
      const referenceBlock = formatReferenceUrls(referenceUrls);
      userPromptWithReferences = `${validatedPrompt.value}\n\n${referenceBlock}`;
    }

    await waitUntilGuestReady(vm);

    const result = await execWithRetry(vm, {
      command: REMOTE_LAUNCH_COMMAND,
      env: {
        PROJECT_DIR: config.projectDir,
        USER_PROMPT: userPromptWithReferences,
        YOUTUBE_UPLOAD: validatedYoutube.value ? "1" : "0",
        PERFORM_CLEANUP: validatedCleanup.value ? "1" : "0",
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
          "Your video task is running in the background. You can safely close this page.",
        code: "LAUNCHED",
        job: {
          pid,
          logPath: `${config.projectDir}/.run/dev.log`,
        },
        imageUrls: referenceUrls,
        finalPrompt: userPromptWithReferences,
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
      console.error("VM guest agent timed out.");
      return json(
        {
          message:
            "The VM started but its internal guest services took too long to initialize. Please try again shortly.",
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
