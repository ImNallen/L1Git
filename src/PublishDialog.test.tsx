// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishDialog } from "./components/PublishDialog";
import * as repositories from "./repositories";
import { oidSchema, rootSchema } from "./domain/repository";
import { branchRefSchema } from "./domain/overview";
import { pushIntentSchema } from "./domain/push";
import type {
  AddRemoteReport,
  PublishOptions,
  PushAvailability,
} from "./domain/push";

vi.mock("./repositories", () => ({
  publishOptions: vi.fn(),
  addRemote: vi.fn(),
  preparePublish: vi.fn(),
}));
const root = rootSchema.parse("/work/repository");
const other = rootSchema.parse("/work/other");
const empty: Extract<PublishOptions, { kind: "available" }> = {
  kind: "available",
  branch: branchRefSchema.parse("refs/heads/topic"),
  source: oidSchema.parse("a".repeat(40)),
  remotes: [],
};
const loaded: PublishOptions = {
  ...empty,
  remotes: [
    {
      name: "origin",
      availability: { kind: "eligible", endpoint: "Configured endpoint" },
    },
  ],
};
const intent = pushIntentSchema.parse({
  purpose: "publish",
  branch: "refs/heads/topic",
  source: "a".repeat(40),
  remote: "origin",
  destination: "refs/heads/release",
  endpoint: "Configured endpoint",
  fingerprint: "b".repeat(40),
});
const added: AddRemoteReport = {
  name: "origin",
  refresh: { kind: "refreshed", options: loaded },
};
const onPublish = vi.fn();
const onClose = vi.fn();
const onRemoteAdded = vi.fn();
let container: HTMLDivElement;
let reactRoot: ReturnType<typeof createRoot>;
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
function input(label: string) {
  const found = [...container.querySelectorAll("label")].find(
    (item) => item.textContent?.trim() === label,
  );
  const control = found?.control;
  if (!(control instanceof HTMLInputElement))
    throw new Error(`Missing input ${label}`);
  return control;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function fill(label: string, value: string) {
  await act(async () => {
    const control = input(label);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Missing native input setter");
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    const form = container.querySelector("form");
    if (!form) throw new Error("Missing publication form");
    form.requestSubmit();
  });
}
async function render(path = root) {
  await act(async () =>
    reactRoot.render(
      <PublishDialog
        root={path}
        onPublish={onPublish}
        onClose={onClose}
        onRemoteAdded={onRemoteAdded}
      />,
    ),
  );
}
async function openAndFill() {
  await click("Add remote…");
  expect(document.activeElement).toBe(input("Remote name"));
  await fill(
    "URL or filesystem path",
    "https://token:secret@example.test/private",
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(repositories.publishOptions).mockResolvedValue(empty);
  vi.mocked(repositories.addRemote).mockResolvedValue(added);
  vi.mocked(repositories.preparePublish).mockResolvedValue({
    kind: "ready",
    intent,
  });
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("routes form submission to Add only, preserves destination, then requires explicit review and publication", async () => {
  await render();
  await fill("Destination branch", "release");
  await openAndFill();
  expect(container.querySelectorAll("form")).toHaveLength(1);
  expect(container.querySelectorAll("dialog")).toHaveLength(1);
  await submit();
  expect(repositories.addRemote).toHaveBeenCalledExactlyOnceWith(root, {
    name: "origin",
    url: "https://token:secret@example.test/private",
  });
  expect(repositories.preparePublish).not.toHaveBeenCalled();
  expect(onPublish).not.toHaveBeenCalled();
  expect(onRemoteAdded).toHaveBeenCalledOnce();
  expect(input("Destination branch").value).toBe("release");
  expect(container.querySelector("select")?.value).toBe("origin");
  expect(container.innerHTML).not.toContain("secret");
  expect(document.activeElement).toBe(button("Review publication"));
  await click("Review publication");
  expect(repositories.preparePublish).toHaveBeenCalledExactlyOnceWith(root, {
    remote: "origin",
    destination: "refs/heads/release",
  });
  expect(onPublish).not.toHaveBeenCalled();
  await click("Publish branch");
  expect(onPublish).toHaveBeenCalledExactlyOnceWith(intent);
});

it("blocks duplicate submission, Escape, backdrop, and close during saving and clears the URL", async () => {
  const saving = deferred<AddRemoteReport>();
  vi.mocked(repositories.addRemote).mockReturnValue(saving.promise);
  await render();
  await openAndFill();
  await submit();
  expect(input("URL or filesystem path").value).toBe("");
  await submit();
  await act(async () => {
    container
      .querySelector("dialog")
      ?.dispatchEvent(
        new Event("cancel", { bubbles: false, cancelable: true }),
      );
    container.querySelector("dialog")?.click();
    container
      .querySelector<HTMLButtonElement>('[aria-label="Close publish branch"]')
      ?.click();
    button("Cancel").click();
    button("Cancel add remote").click();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(repositories.addRemote).toHaveBeenCalledOnce();
  expect(button("Adding remote…").matches(":disabled")).toBe(true);
  expect(button("Review publication").disabled).toBe(true);
  await act(async () => saving.resolve(added));
});

it("invalidates an existing review on opening and canceling Add", async () => {
  vi.mocked(repositories.publishOptions).mockResolvedValue(loaded);
  await render();
  await click("Review publication");
  expect(button("Publish branch")).toBeDefined();
  await openAndFill();
  expect(
    container.querySelector('[aria-label="Publication review"]'),
  ).toBeNull();
  await click("Cancel add remote");
  expect(button("Review publication").disabled).toBe(false);
  expect(document.activeElement).toBe(button("Review publication"));
  expect(repositories.addRemote).not.toHaveBeenCalled();
  expect(onPublish).not.toHaveBeenCalled();
});

it("discards preparation that resolves after the editor opens", async () => {
  const preparation = deferred<PushAvailability>();
  vi.mocked(repositories.publishOptions).mockResolvedValue(loaded);
  vi.mocked(repositories.preparePublish).mockReturnValue(preparation.promise);
  await render();
  await click("Review publication");
  await openAndFill();
  await act(async () => preparation.resolve({ kind: "ready", intent }));
  expect(
    container.querySelector('[aria-label="Publication review"]'),
  ).toBeNull();
  await submit();
  expect(onPublish).not.toHaveBeenCalled();
  expect(button("Review publication").disabled).toBe(false);
});

it("discards old initial options after addition", async () => {
  const initial = deferred<PublishOptions>();
  vi.mocked(repositories.publishOptions).mockReturnValueOnce(initial.promise);
  await render();
  await openAndFill();
  await submit();
  await act(async () => initial.resolve(empty));
  expect(container.querySelector("select")?.value).toBe("origin");
  expect(button("Review publication").disabled).toBe(false);
});

it("reloads initial options when Add is canceled before they arrive", async () => {
  const initial = deferred<PublishOptions>();
  vi.mocked(repositories.publishOptions)
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce(loaded);
  await render();
  await openAndFill();
  await click("Cancel add remote");
  expect(container.querySelector("select")?.value).toBe("origin");
  await act(async () => initial.resolve(empty));
  expect(container.querySelector("select")?.value).toBe("origin");
  expect(repositories.addRemote).not.toHaveBeenCalled();
});

it("offers read-only retry after committed refresh failure and keeps the destination", async () => {
  vi.mocked(repositories.addRemote).mockResolvedValue({
    name: "origin",
    refresh: {
      kind: "failed",
      message: "The remote was added. Reload remotes.",
    },
  });
  await render();
  await fill("Destination branch", "release");
  await openAndFill();
  await submit();
  expect(container.textContent).toContain("The remote was added.");
  expect(container.querySelector("fieldset")).toBeNull();
  await submit();
  vi.mocked(repositories.publishOptions).mockResolvedValueOnce(loaded);
  await click("Reload remotes");
  expect(repositories.addRemote).toHaveBeenCalledOnce();
  expect(repositories.preparePublish).not.toHaveBeenCalled();
  expect(input("Destination branch").value).toBe("release");
  expect(container.querySelector("select")?.value).toBe("origin");
  expect(button("Review publication").disabled).toBe(false);
});

it("requires reloading after lost transport and never echoes its diagnostics", async () => {
  vi.mocked(repositories.addRemote).mockRejectedValue(
    new Error("secret URL diagnostics"),
  );
  await render();
  await openAndFill();
  await submit();
  expect(container.textContent).toContain(
    "Could not confirm whether the remote was added",
  );
  expect(container.innerHTML).not.toContain("secret");
  expect(button("Add remote…").disabled).toBe(true);
  await submit();
  expect(repositories.addRemote).toHaveBeenCalledOnce();
  await click("Reload remotes");
  expect(button("Add remote…").disabled).toBe(false);
});

it("shows a precommit refusal, clears its URL, and permits correction", async () => {
  vi.mocked(repositories.addRemote).mockRejectedValueOnce({
    kind: "gitFailed",
    message: "A remote with this name is already configured.",
  });
  await render();
  await openAndFill();
  await submit();
  expect(container.textContent).toContain("already configured");
  expect(input("URL or filesystem path").value).toBe("");
  await fill("Remote name", "upstream");
  await fill("URL or filesystem path", "../endpoint");
  await submit();
  expect(repositories.addRemote).toHaveBeenCalledTimes(2);
  expect(onRemoteAdded).toHaveBeenCalledOnce();
});

it.each(["unavailable", "ineligible"])(
  "keeps review disabled after refreshed %s options",
  async (kind) => {
    const options: PublishOptions =
      kind === "unavailable"
        ? { kind: "unavailable", reason: "detached" }
        : {
            ...empty,
            remotes: [
              {
                name: "origin",
                availability: { kind: "unavailable", reason: "mirror" },
              },
            ],
          };
    vi.mocked(repositories.addRemote).mockResolvedValue({
      name: "origin",
      refresh: { kind: "refreshed", options },
    });
    await render();
    await openAndFill();
    await submit();
    expect(button("Review publication").disabled).toBe(true);
    expect(container.textContent).toContain(
      kind === "unavailable" ? "Check out a branch" : "mirror",
    );
  },
);

it.each(["root change", "unmount"])(
  "ignores add responses after %s",
  async (change) => {
    const saving = deferred<AddRemoteReport>();
    vi.mocked(repositories.addRemote).mockReturnValue(saving.promise);
    await render();
    await openAndFill();
    await submit();
    if (change === "root change") await render(other);
    else await act(async () => reactRoot.render(null));
    await act(async () => saving.resolve(added));
    expect(onRemoteAdded).not.toHaveBeenCalled();
    if (change === "root change") {
      expect(container.querySelector("select")?.value).toBe("");
      expect(button("Review publication").disabled).toBe(true);
    } else expect(container.childElementCount).toBe(0);
  },
);

it("discards option and prepare responses across root lifetimes", async () => {
  const oldOptions = deferred<PublishOptions>();
  vi.mocked(repositories.publishOptions)
    .mockReturnValueOnce(oldOptions.promise)
    .mockResolvedValueOnce(empty);
  await render();
  await render(other);
  await act(async () => oldOptions.resolve(loaded));
  expect(container.querySelector("select")?.value).toBe("");
  const oldPrepare = deferred<PushAvailability>();
  vi.mocked(repositories.publishOptions).mockResolvedValue(loaded);
  vi.mocked(repositories.preparePublish).mockReturnValueOnce(
    oldPrepare.promise,
  );
  await render(root);
  await click("Review publication");
  await render(other);
  await act(async () => oldPrepare.resolve({ kind: "ready", intent }));
  expect(
    container.querySelector('[aria-label="Publication review"]'),
  ).toBeNull();
  expect(onPublish).not.toHaveBeenCalled();
});
