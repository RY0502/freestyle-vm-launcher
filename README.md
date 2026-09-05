# Deepframe

A Vercel-ready Next.js app that accepts a video prompt, wakes one paused
Freestyle VM, and starts the VM's existing `freeai-video-deepagent` process as
a detached background job.

## What happens on submit

1. The server validates the prompt.
2. It fetches `FREESTYLE_VM_ID` and accepts only an exact `paused` state.
3. A running or transitioning VM returns HTTP `409` with:
   `The VM is already running. Try back again in some time.`
4. A paused VM is started and polled until it reports `running`.
5. The server submits a fixed shell program through Freestyle's SDK. The prompt
   is passed as an environment value, never interpolated into shell source.
6. If the prompt contains `upload to youtube` or `upload to you tube`
   (case-insensitive), the launcher adds `--youtube` before the prompt.
7. The VM runs one of these forms:

   ```bash
   nohup /usr/local/bin/npm run dev -- "$USER_PROMPT" >>.run/dev.log 2>&1 </dev/null &
   nohup /usr/local/bin/npm run dev -- --youtube "$USER_PROMPT" >>.run/dev.log 2>&1 </dev/null &
   ```

   `"$USER_PROMPT"` keeps the complete prompt as one argument. The quotes are
   shell grouping and are not included in the prompt received by the npm script.

8. The API returns HTTP `202` as soon as the VM acknowledges the background
   PID. Closing the browser or ending the Vercel request does not stop the job.

The VM-side launcher also holds `.run/dev.lock` for the life of the npm process
and checks `.run/dev.pid`. This prevents two concurrent Vercel invocations from
launching duplicate jobs after both observe the VM as paused.

## Why the SDK is used instead of vm ssh

Freestyle documents `vm ssh` as an interactive PTY/login-shell command. That is
useful at a terminal, but it can wait indefinitely in a serverless function.
This app pins the official `freestyle` package and uses `vms.get()`,
`vm.start()`, and `vm.exec()`—the supported non-interactive path.

An API key already belongs to a Freestyle team, so the SDK does not accept a
team ID in API-key mode. `FREESTYLE_TEAM_ID` is retained as deployment
configuration for your operational CLI commands; `FREESTYLE_API_KEY` selects
the team for application calls.

References:

- [Freestyle VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle)
- [Freestyle VM CLI and exec behavior](https://www.freestyle.sh/docs/vms/cli)
- [Freestyle CLI authentication](https://www.freestyle.sh/docs/cli)

## Local setup

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill every required value in `.env.local`. Never prefix the Freestyle API key,
VM ID, or team ID with `NEXT_PUBLIC_`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `FREESTYLE_API_KEY` | Yes | Server-side Freestyle API authentication |
| `FREESTYLE_VM_ID` | Yes | The single VM this app is allowed to launch |
| `FREESTYLE_TEAM_ID` | Yes | Team identifier used for manual CLI operations |
| `FREESTYLE_PROJECT_DIR` | No | Absolute VM project path; defaults to `/home/ubuntu/freeai-video-deepagent` |
| `FREESTYLE_LINUX_USER` | No | Linux user used by `vm.exec`; defaults to the VM's uid-1000 user when omitted |
| `APP_ORIGIN` | Production | Exact browser origin allowed to submit jobs |
| `NEXT_PUBLIC_APP_URL` | Production | Trusted canonical URL for social metadata |

Create a non-interactive Freestyle API key from an authenticated terminal:

```bash
npx freestyle@latest tokens create "deepframe-vercel"
```

## VM prerequisites

The configured Linux user must have:

- the project at `FREESTYLE_PROJECT_DIR`;
- npm at `/usr/local/bin/npm`;
- `flock` at `/usr/bin/flock`;
- permission to create `.run`, `.run/dev.log`, `.run/dev.pid`, and
  `.run/dev.lock`;
- an `npm run dev` script that accepts one prompt argument after npm's `--`
  separator, with an optional `--youtube` argument before it.

If your VM paths differ, update `REMOTE_LAUNCH_COMMAND` in
`src/app/api/launch/route.ts` or the project-directory environment variable.

## Logs and operations

Open an interactive VM session when you need to inspect the job:

```bash
npx freestyle@latest vm ssh "$FREESTYLE_VM_ID" --team "$FREESTYLE_TEAM_ID"
```

Inside the VM:

```bash
tail -n 200 -f /home/ubuntu/freeai-video-deepagent/.run/dev.log
cat /home/ubuntu/freeai-video-deepagent/.run/dev.pid
```

Use the configured project path if it differs.

Pausing a Freestyle VM freezes its memory and active processes. Do not pause it
immediately after launch, because that freezes the running job. Once the job is
finished, pause it from an authenticated terminal:

```bash
npx freestyle@latest vm pause "$FREESTYLE_VM_ID" --team "$FREESTYLE_TEAM_ID"
```

For automated completion, use a trusted controller or signed completion
callback that checks the PID/result first and then calls `vm.pause()`. Do not
put the team API key inside the VM.

## Deploy to Vercel

1. Push this directory to a Git repository and import it into Vercel.
2. Add the variables from `.env.example` to the Production environment.
3. Set `APP_ORIGIN` and `NEXT_PUBLIC_APP_URL` to the exact HTTPS production URL.
4. Deploy. The endpoint explicitly uses the Node.js runtime and a 60-second
   maximum duration.
5. Add Vercel Firewall rate limiting or restrict the deployment to approved
   users if organization authentication is required.

The route intentionally never pauses the VM after launch. A timeout can be
ambiguous—the background task might already have started—so inspect the PID and
log before retrying.

To pause a configured VM through the app, send a GET request to
`/pause/vm`. The endpoint checks the current state first, does nothing when the
VM is already paused or pausing, and logs each decision. Add `?machine=1` or
another positive machine number to select the corresponding suffixed variables,
such as `FREESTYLE_API_KEY_1`, `FREESTYLE_VM_ID_1`, and
`FREESTYLE_TEAM_ID_1`. Without `machine`, it uses the unsuffixed variables.

The pause endpoint does not require authentication. To start a numbered VM and
launch its `prompt.txt` process, send a GET request to `/start/vm?machine=1`.
The `machine` query parameter is required, and the endpoint uses only the
matching suffixed variables. It does nothing when the VM is already running or
starting, and logs each state check and launch result.
The numbered start route also requires `FREESTYLE_PROJECT_DIR_1` (or the
matching machine suffix) for the VM project directory. Routes using no machine
number use the unsuffixed `FREESTYLE_PROJECT_DIR` default.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
```
