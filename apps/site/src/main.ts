import "./styles.css";

/**
 * The hero list, driven by the keyboard.
 *
 * A landing page for a keyboard-first client can describe the bindings or it
 * can hand them over. This hands them over: `j` and `k` move the cursor and
 * `↵` expands a row, using the same keys the client uses, so the pitch is
 * something the visitor does rather than something they are told.
 *
 * It is the only animated thing on the page. A page arguing that nothing
 * should wait on a round trip has no business making you wait for a fade-in,
 * so there are no scroll reveals anywhere else.
 */

type Task = { title: string; status: string; tone: string; meta: string; detail: string };

/* Written to read like a real backlog for this project, because a demo list of
   "Task one / Task two" tells a visitor nothing about what the rows hold. */
const TASKS: Task[] = [
  {
    title: "Page a list oldest-first so an interrupted read resumes",
    status: "In progress",
    tone: "text-accent",
    meta: "worker",
    detail: "A full load of 17,049 tasks is 196 requests. Resuming beats restarting.",
  },
  {
    title: "Reconcile drops subtasks closed since the last pass",
    status: "Open",
    tone: "text-ink-3",
    meta: "schema",
    detail: "The nightly pass is the backstop for anything polling and webhooks both missed.",
  },
  {
    title: "Rate limiter should round-robin across signed-in tokens",
    status: "Open",
    tone: "text-ink-3",
    meta: "clickup-client",
    detail: "100 requests per minute is per token, so more tokens is more headroom.",
  },
  {
    title: "Webhook health check flaps on a slow deploy",
    status: "Blocked",
    tone: "text-urgent",
    meta: "worker",
    detail: "100 delivery failures suspend the webhook at ClickUp's end. Flapping spends them.",
  },
  {
    title: "Command palette should rank recently opened tasks first",
    status: "Done",
    tone: "text-ink-4",
    meta: "web",
    detail: "Ranking by recency is the difference between two keystrokes and reading a list.",
  },
];

const list = document.querySelector<HTMLElement>("[data-demo]");
const hint = document.querySelector<HTMLElement>("[data-demo-hint]");

if (list) {
  let cursor = 2;
  let expanded = false;
  let touched = false;

  list.innerHTML = TASKS.map(
    (task, index) => `
    <li>
      <button type="button" data-row="${index}"
        class="group flex w-full items-center gap-3 px-3 py-2 text-left sm:gap-4 sm:px-4">
        <span data-bar class="h-4 w-[2px] shrink-0 rounded-[1px] [transform:skewX(-12deg)]"></span>
        <span data-title class="flex-1 truncate text-sm sm:text-base">${task.title}</span>
        <span class="hidden shrink-0 font-mono text-ink-4 text-xs sm:inline">${task.meta}</span>
        <span class="shrink-0 ${task.tone} text-xs tabular-nums">${task.status}</span>
      </button>
      <p data-detail hidden
        class="border-line border-l-2 px-3 pb-3 pl-6 text-ink-3 text-sm sm:px-4 sm:pl-8">
        ${task.detail}
      </p>
    </li>`,
  ).join("");

  const rows = [...list.querySelectorAll<HTMLElement>("[data-row]")];
  const details = [...list.querySelectorAll<HTMLElement>("[data-detail]")];

  function paint() {
    rows.forEach((row, index) => {
      const on = index === cursor;
      row.querySelector("[data-bar]")?.classList.toggle("bg-accent", on);
      row.querySelector("[data-title]")?.classList.toggle("text-ink", on);
      row.querySelector("[data-title]")?.classList.toggle("text-ink-2", !on);
      row.classList.toggle("bg-selected", on);
      row.setAttribute("aria-current", on ? "true" : "false");
    });
    details.forEach((detail, index) => {
      detail.hidden = !(expanded && index === cursor);
    });
  }

  function move(delta: number) {
    touched = true;
    cursor = Math.min(TASKS.length - 1, Math.max(0, cursor + delta));
    expanded = false;
    paint();
  }

  // Only while the list is on screen, and never while something is focused
  // that wants the same keys. A page that swallows `j` inside a text field is
  // a page that has misunderstood what keyboard-first means.
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;

    if (event.key === "j") move(1);
    else if (event.key === "k") move(-1);
    else if (event.key === "Enter" && rows.some((row) => row === document.activeElement)) return;
    else if (event.key === "Enter") {
      touched = true;
      expanded = !expanded;
      paint();
    } else return;

    event.preventDefault();
  });

  // Touch has no keyboard, so the rows are buttons and taps do the same thing.
  rows.forEach((row, index) => {
    row.addEventListener("click", () => {
      touched = true;
      expanded = index === cursor ? !expanded : false;
      cursor = index;
      paint();
    });
  });

  paint();

  /*
   * One nudge, once.
   *
   * A visitor who never presses a key sees a static list and never learns it
   * is live. The cursor steps down and back a single time to say otherwise —
   * not a loop, and not at all for anyone who has asked for less motion.
   */
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!still) {
    setTimeout(() => {
      if (touched) return;
      cursor = 3;
      paint();
      setTimeout(() => {
        if (touched) return;
        cursor = 2;
        paint();
      }, 620);
    }, 2600);
  }

  // The hint names the input the visitor actually has.
  if (hint && window.matchMedia("(hover: none)").matches) {
    hint.textContent = "Tap a row to open it.";
  }
}
