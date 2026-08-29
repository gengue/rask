import { isClosedType } from "@rask/clickup-client/vocabulary";
import { createSignal, type JSX, Show } from "solid-js";
import { resolvedTheme } from "./theme.ts";

/**
 * VICTORY ACHIEVED, for a task manager.
 *
 * The other half of the Ember easter egg: finishing work in a Souls game gets
 * you a full-screen banner and a chime, and clearing your inbox deserves no
 * less. The art and the sound are lifted from elden-all
 * (github.com/gengue/elden-all, MIT), which does the same to GitHub; the webps
 * are a transparent 1920×1080 frame with the banner band across the middle,
 * so stretching them over the viewport is the whole layout.
 *
 * Two rules keep it an easter egg rather than a nuisance. It only fires under
 * the Ember theme — `celebrate` is safe to call unconditionally from write
 * paths, and is a no-op everywhere else. And it never queues: a second
 * trigger while a banner is up is dropped, because two victories forty pixels
 * apart is a slot machine, not a moment.
 *
 * The audio call can be refused (autoplay policy, first load with no
 * gesture); the banner still shows. Both triggers ride user actions — a
 * status picked from a menu, the inbox's own clear button — so in practice
 * the gesture is fresh and the sound plays.
 */
const ART = {
  inboxCleared: { image: "/ember/inbox-cleared.webp", sound: "/ember/new-item.mp3" },
  taskDone: { image: "/ember/task-done.webp", sound: "/ember/new-item.mp3" },
} as const;

export type Celebration = keyof typeof ART;

const [current, setCurrent] = createSignal<Celebration | null>(null);

/** Whether a status change is the moment work got finished, not a lateral move. */
export function justClosed(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return isClosedType(after) && !isClosedType(before);
}

export function celebrate(kind: Celebration): void {
  if (resolvedTheme() !== "ember") return;
  if (current()) return;
  const audio = new Audio(ART[kind].sound);
  audio.volume = 0.25;
  void audio.play().catch(() => {});
  setCurrent(kind);
}

/** Mounted once in the shell; owns nothing but the fade. */
export function CelebrationBanner(): JSX.Element {
  return (
    <Show when={current()} keyed>
      {(kind) => (
        <img
          src={ART[kind].image}
          alt=""
          class="ember-banner"
          onAnimationEnd={() => setCurrent(null)}
        />
      )}
    </Show>
  );
}
