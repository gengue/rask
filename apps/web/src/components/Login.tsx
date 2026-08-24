import { type JSX, Show } from "solid-js";

export { signInError } from "../lib/sign-in-error.ts";

/**
 * The only way in.
 *
 * There was no page here at all: a 401 sent the browser straight to
 * `/auth/clickup`, on the reasoning that a page holding one button is a page
 * you always click through. That held until sign-in could be *refused* — the
 * workspace gate answers 403 to an account outside it — and a refusal had
 * nowhere to land and nothing saying why.
 *
 * It also names the thing you are about to authorize before sending you to
 * ClickUp's consent screen, which is worth one click.
 */
export function Login(props: { reason?: string }): JSX.Element {
  return (
    <main class="flex min-h-dvh items-center justify-center bg-app px-6">
      <div class="w-full max-w-[320px]">
        <h1 class="font-medium text-ink text-lg">Rask</h1>
        <p class="mt-1 text-ink-2 text-sm leading-relaxed">
          A faster way into ClickUp. Sign in with the ClickUp account you already use for this
          workspace.
        </p>

        <Show when={props.reason}>
          {(reason) => (
            <p
              role="alert"
              class="mt-4 rounded-md border border-urgent/40 bg-urgent/10 px-3 py-2 text-sm text-urgent"
            >
              {reason()}
            </p>
          )}
        </Show>

        {/*
          A plain link, not a fetch: `/auth/clickup` answers with a redirect to
          ClickUp and sets the state cookie on the way, and both need to be a
          real navigation.
        */}
        <a
          href="/auth/clickup"
          class="mt-5 flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-on-accent text-sm transition-opacity hover:opacity-90"
        >
          Continue with ClickUp
        </a>

        <p class="mt-4 text-ink-4 text-xs leading-relaxed">
          Rask reads and writes on your behalf using your own ClickUp account, so it can only ever
          do what you could do yourself.
        </p>
      </div>
    </main>
  );
}
