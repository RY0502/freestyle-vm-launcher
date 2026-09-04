"use client";

import { FormEvent, useState } from "react";

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

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [launchState, setLaunchState] = useState<LaunchState>({ type: "idle" });

  const trimmedPrompt = prompt.trim();
  const isLoading = launchState.type === "loading";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!trimmedPrompt || isLoading) return;

    setLaunchState({ type: "loading" });

    try {
      const response = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });

      const data = (await response.json()) as { message?: string };

      if (!response.ok) {
        throw new Error(data.message ?? "We couldn’t start the render. Please try again.");
      }

      setLaunchState({
        type: "success",
        message: data.message ?? "Your render has been queued and is now running.",
      });
      setPrompt("");
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
    setLaunchState({ type: "idle" });
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
