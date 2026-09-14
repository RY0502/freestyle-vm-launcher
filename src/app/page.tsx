"use client";

import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

type LaunchState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

const EXAMPLES = [
  "A cinematic product reveal in a desert at blue hour",
  "An energetic launch film for a climate-tech startup",
  "A quiet, hand-drawn story about finding your way home",
];

const STORAGE_KEY_PROMPT = "freestyle_vm_latest_prompt";
const STORAGE_KEY_DEPLOY = "freestyle_vm_deploy_id";
const CURRENT_DEPLOY_ID = process.env.NEXT_PUBLIC_DEPLOY_ID || "development";

let promptListeners: Array<() => void> = [];

function emitPromptChange() {
  for (const listener of promptListeners) {
    listener();
  }
}

function subscribeToPrompt(listener: () => void) {
  promptListeners.push(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY_PROMPT || event.key === STORAGE_KEY_DEPLOY) {
      listener();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    promptListeners = promptListeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getPromptSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const savedDeployId = localStorage.getItem(STORAGE_KEY_DEPLOY);

    // If the app has been redeployed since this prompt was saved, clear it
    if (savedDeployId && savedDeployId !== CURRENT_DEPLOY_ID) {
      localStorage.removeItem(STORAGE_KEY_PROMPT);
      localStorage.setItem(STORAGE_KEY_DEPLOY, CURRENT_DEPLOY_ID);
      return null;
    }

    if (!savedDeployId) {
      localStorage.setItem(STORAGE_KEY_DEPLOY, CURRENT_DEPLOY_ID);
    }

    return localStorage.getItem(STORAGE_KEY_PROMPT);
  } catch {
    return null;
  }
}

function getPromptServerSnapshot(): string | null {
  return null;
}

function saveLatestPrompt(newPrompt: string) {
  try {
    localStorage.setItem(STORAGE_KEY_PROMPT, newPrompt);
    localStorage.setItem(STORAGE_KEY_DEPLOY, CURRENT_DEPLOY_ID);
  } catch (err) {
    console.error("Failed to save latest prompt to localStorage:", err);
  }
  emitPromptChange();
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const latestPrompt = useSyncExternalStore(
    subscribeToPrompt,
    getPromptSnapshot,
    getPromptServerSnapshot
  );
  const [copied, setCopied] = useState(false);
  const [youtube, setYoutube] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [launchState, setLaunchState] = useState<LaunchState>({ type: "idle" });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmedPrompt = prompt.trim();
  const isLoading = launchState.type === "loading";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!trimmedPrompt || isLoading) return;

    const submittedPrompt = trimmedPrompt;
    saveLatestPrompt(submittedPrompt);
    setPrompt("");
    setLaunchState({ type: "loading" });

    try {
      const response = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: submittedPrompt,
          youtube,
          cleanup,
        }),
      });

      const data = (await response.json()) as { message?: string };

      if (!response.ok) {
        throw new Error(data.message ?? "We couldn’t start the render. Please try again.");
      }

      setLaunchState({
        type: "success",
        message: data.message ?? "Your render has been queued and is now running.",
      });
    } catch (error) {
      setLaunchState({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "We couldn’t start the render. Please try again.",
      });
    }
  }

  function selectExample(example: string) {
    setPrompt(example);
    if (launchState.type !== "idle") setLaunchState({ type: "idle" });
    textareaRef.current?.focus();
  }

  async function handleCopyPrompt() {
    if (!latestPrompt) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(latestPrompt);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = latestPrompt;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = latestPrompt;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
      } catch (err) {
        console.error("Failed to copy prompt:", err);
      }
    }
  }

  function handleRetryPrompt() {
    if (!latestPrompt) return;
    setPrompt(latestPrompt);
    if (launchState.type !== "idle") setLaunchState({ type: "idle" });
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <main className="site-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="Deepframe home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>Deepframe</span>
        </a>
        <div className="nav-status">
          <span className="status-dot" aria-hidden="true" />
          Private render studio
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow">
          <span>Prompt to motion</span>
          <span className="eyebrow-line" />
          <span>Built for deep work</span>
        </div>

        <h1>
          Your next story,
          <span> set in motion.</span>
        </h1>

        <p className="hero-copy">
          Describe the film you can see in your head. We’ll wake a dedicated
          studio and send your idea into production.
        </p>

        <form className="composer" onSubmit={handleSubmit}>
          <div className="composer-topline">
            <label htmlFor="prompt">Describe your video</label>
            <span>{prompt.length.toLocaleString()} / 4,000</span>
          </div>

          <textarea
            ref={textareaRef}
            id="prompt"
            name="prompt"
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (launchState.type !== "idle") setLaunchState({ type: "idle" });
            }}
            maxLength={4000}
            rows={6}
            placeholder="A surreal short film about a lighthouse keeper who receives messages from the future…"
            aria-describedby="prompt-help"
            disabled={isLoading}
            required
          />

          <div className="composer-footer">
            <p id="prompt-help">
              Include mood, pacing, and visual style. Add “upload to YouTube”
              anywhere when you want the result published there.
            </p>
            <button type="submit" disabled={!trimmedPrompt || isLoading}>
              {isLoading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Waking studio
                </>
              ) : (
                <>
                  Start creating
                  <span className="button-arrow" aria-hidden="true">→</span>
                </>
              )}
            </button>
          </div>

          <div className="composer-options" aria-label="Video options">
            <label className="toggle-option">
              <input
                type="checkbox"
                checked={youtube}
                onChange={(event) => setYoutube(event.target.checked)}
                disabled={isLoading}
              />
              <span className="toggle-track" aria-hidden="true"><span /></span>
              <span>
                <strong>YouTube</strong>
                <small>Upload the finished video</small>
              </span>
            </label>
            <label className="toggle-option">
              <input
                type="checkbox"
                checked={cleanup}
                onChange={(event) => setCleanup(event.target.checked)}
                disabled={isLoading}
              />
              <span className="toggle-track" aria-hidden="true"><span /></span>
              <span>
                <strong>Cleanup</strong>
                <small>Clean up after successful load</small>
              </span>
            </label>
          </div>

          <div aria-live="polite" aria-atomic="true">
            {launchState.type === "success" && (
              <div className="notice notice-success" role="status">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>Studio is running</strong>
                  <p>{launchState.message}</p>
                </div>
              </div>
            )}
            {launchState.type === "error" && (
              <div className="notice notice-error" role="alert">
                <span aria-hidden="true">!</span>
                <div>
                  <strong>Studio unavailable</strong>
                  <p>{launchState.message}</p>
                </div>
              </div>
            )}
          </div>
        </form>

        {latestPrompt && (
          <div className="latest-prompt-card" aria-label="Latest submitted prompt">
            <div className="latest-prompt-header">
              <div className="latest-prompt-badge">
                <span className="latest-prompt-indicator" aria-hidden="true" />
                <span>Latest Prompt</span>
              </div>
              <div className="latest-prompt-actions">
                <button
                  type="button"
                  className="latest-prompt-action-btn"
                  onClick={handleCopyPrompt}
                  title="Copy prompt to clipboard"
                  aria-label={copied ? "Copied prompt" : "Copy prompt"}
                >
                  {copied ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="latest-prompt-action-btn latest-prompt-action-btn-retry"
                  onClick={handleRetryPrompt}
                  title="Load this prompt back into the composer to retry"
                  aria-label="Retry this prompt"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  <span>Retry prompt</span>
                </button>
              </div>
            </div>
            <p className="latest-prompt-content">{latestPrompt}</p>
          </div>
        )}

        <div className="examples" aria-label="Example prompts">
          <span className="examples-label">Try a direction</span>
          <div className="example-list">
            {EXAMPLES.map((example, index) => (
              <button key={example} type="button" onClick={() => selectExample(example)}>
                <span>0{index + 1}</span>
                {example}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="process" aria-label="How it works">
        <div className="process-heading">
          <p>One prompt. One focused studio.</p>
          <span>Your job keeps running even after you close this page.</span>
        </div>

        <ol>
          <li>
            <span>01</span>
            <div>
              <strong>Share the vision</strong>
              <p>Give the agent a clear creative brief in your own words.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Wake the studio</strong>
              <p>A private Freestyle VM resumes exactly where it left off.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Let it run</strong>
              <p>The render continues in the background while you move on.</p>
            </div>
          </li>
        </ol>
      </section>

      <footer>
        <span>Deepframe / Creative runtime</span>
        <span>Powered by Freestyle</span>
      </footer>
    </main>
  );
}
