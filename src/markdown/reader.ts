import type { Tree } from "./tree";

export type Question = { text: string; base: string };
export type Answer = "ready" | { tree: Tree | null };

/** Starts something that reads one text at a time, once it said it is ready. */
export type Start = (
  heard: (answer: Answer) => void,
  failed: () => void,
) => { ask: (question: Question) => void; stop: () => void };

type Request = {
  question: Question;
  isWanted: () => boolean;
  /** Takes null for a text that is better shown as it was written. */
  done: (tree: Tree | null) => void;
};

const BUDGET_MS = 300;
/** What a worker read stays in its memory, so it is replaced after this much. */
const HEAVY_MS = 50;
const IDLE_MS = 10_000;
const MOST_KEPT = { texts: 500, characters: 8_000_000 };

/** What was read, down to a number of texts and of characters. */
class Kept {
  private trees = new Map<string, Tree | null>();
  private characters = 0;

  private static key = ({ text, base }: Question) => `${base}\n${text}`;
  /** A piece takes as much memory as 50 characters. */
  private static size = (key: string, tree: Tree | null) =>
    key.length + (tree ? tree.size + 50 * tree.weight : 0);

  get(question: Question): Tree | null | undefined {
    const key = Kept.key(question);
    const tree = this.trees.get(key);
    if (tree === undefined) return undefined;
    this.trees.delete(key);
    this.trees.set(key, tree);
    return tree;
  }

  add(question: Question, tree: Tree | null) {
    const key = Kept.key(question);
    this.trees.set(key, tree);
    this.characters += Kept.size(key, tree);
    for (const [oldest, read] of this.trees) {
      if (
        this.trees.size <= MOST_KEPT.texts &&
        this.characters <= MOST_KEPT.characters
      )
        return;
      this.trees.delete(oldest);
      this.characters -= Kept.size(oldest, read);
    }
  }
}

/** Reads Markdown where no text can hold up the window, however it is written. */
export class MarkdownReader {
  private kept = new Kept();
  private waiting = new Set<Request>();
  private running: Request | null = null;
  private worker: ReturnType<Start> | null = null;
  private ready = false;
  private unavailable = false;
  private askedAt = 0;
  private timer = 0;
  private idle = 0;

  constructor(private start: Start) {}

  /** The wanted ones are read first. Returns how to stop waiting for it. */
  read(
    question: Question,
    isWanted: () => boolean,
    done: Request["done"],
  ): () => void {
    const request = { question, isWanted, done };
    this.waiting.add(request);
    this.next();
    return () => this.waiting.delete(request);
  }

  /** Starts the worker, so that it is ready by the time there is a text. */
  warm() {
    if (this.worker || this.unavailable) return;
    const isOwn = () => this.worker === worker;
    let worker: ReturnType<Start> | null = null;
    try {
      worker = this.start(
        (answer) => {
          if (!isOwn()) return;
          if (answer === "ready") this.ready = true;
          else this.finish(answer.tree);
          this.next();
        },
        () => {
          if (!isOwn()) return;
          this.unavailable = !this.ready;
          this.giveUp(false);
        },
      );
    } catch {
      this.unavailable = true;
    }
    this.worker = worker;
  }

  private next() {
    window.clearTimeout(this.idle);
    while (!this.running && this.waiting.size > 0) {
      const all = [...this.waiting];
      const request = all.find(({ isWanted }) => isWanted()) ?? all[0]!;
      const { question } = request;
      const known = this.unavailable ? null : this.kept.get(question);
      if (known !== undefined) this.answer(request, known);
      else if (this.worker && this.ready) {
        this.running = request;
        this.askedAt = performance.now();
        this.worker.ask(question);
        // What was answered while the window was busy is heard first.
        this.timer = window.setTimeout(() => {
          this.timer = window.setTimeout(() => this.giveUp(true));
        }, BUDGET_MS);
      } else {
        this.warm();
        if (!this.unavailable) return;
      }
    }
    if (!this.running)
      this.idle = window.setTimeout(() => this.stop(), IDLE_MS);
  }

  private answer(request: Request, tree: Tree | null) {
    if (this.waiting.delete(request)) request.done(tree);
  }

  private finish(tree: Tree | null, keep = true) {
    window.clearTimeout(this.timer);
    if (performance.now() - this.askedAt > HEAVY_MS) this.stop();
    const request = this.running;
    this.running = null;
    if (!request) return;
    if (keep) this.kept.add(request.question, tree);
    this.answer(request, tree);
  }

  private stop() {
    this.worker?.stop();
    this.worker = null;
    this.ready = false;
  }

  /** A worker that broke says nothing about its text, which may be asked again. */
  private giveUp(keep: boolean) {
    this.stop();
    this.finish(null, keep);
    this.next();
  }
}
