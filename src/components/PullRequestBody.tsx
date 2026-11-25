import {
  Component,
  Fragment,
  memo,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { markdownReader } from "../markdown/markdownReader";
import { runs, turnsIn } from "../markdown/runs";
import type { Tree } from "../markdown/tree";
import { Markdown } from "./Markdown";
import { SurroundingsContext } from "./pullRequestText";
import { TurnsContext } from "./turns";

/** Whatever a text holds, reading it must not take the screen down. */
export class Plainly extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const LONG = 20_000;
/** Most texts are read by then, and need not be shown as they were written. */
const SOON_MS = 100;
/** In some scripts, laying out twice as much takes 200 ms in WebKit. */
const PARAGRAPH = 1_000;

/** The start of a text, up to the end of a line if there is one. */
function beginning(text: string, length: number) {
  const line = text.lastIndexOf("\n", length);
  return text.slice(0, line > 0 ? line : length);
}

function paragraphsOf(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  while (rest.length > PARAGRAPH) {
    const next = beginning(rest, PARAGRAPH);
    found.push(next);
    rest = rest.slice(next.length).replace(/^\n/, "");
  }
  return [...found, rest];
}

const Paragraph = memo(function Paragraph({ text }: { text: string }) {
  return (
    <pre>
      {runs(text).map((run, at) => (
        <Fragment key={at}>
          {at > 0 && <wbr />}
          {run}
        </Fragment>
      ))}
    </pre>
  );
});

/** A text as it was written. */
function Plain({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <div className="markdown-plain">
      {paragraphs.map((text, at) => (
        <Paragraph key={at} text={text} />
      ))}
    </div>
  );
}

type Content = {
  text: string;
  /** Without one, the text is shown as it was written. */
  tree: Tree | null;
  paragraphs: string[];
  weight: number;
};

const contentOf = (text: string, tree: Tree | null): Content => ({
  text,
  tree,
  paragraphs: paragraphsOf(text),
  // A turn to another script and back is two pieces of a line.
  weight: tree?.weight ?? text.length / 20 + 2 * turnsIn(text),
});

/** In how many steps a text is shown, since all of a long one takes long. */
const stepsOf = ({ tree, paragraphs }: Content) =>
  tree ? 1 : paragraphs.length;

/** How much of a text is shown, and how much space it takes until all is. */
type Showing = { content: Content | null; steps: number; height: number };

/** About how high a text will be, so that less moves when it is shown. */
const heightOf = (text: string) => Math.ceil(text.length / 80) * 21;

/** In the view, the text before stays until this one is read. */
function useReading(place: RefObject<Element | null>, text: string): Showing {
  const turns = use(TurnsContext);
  const { base } = use(SurroundingsContext);
  const [showing, setShowing] = useState<Showing>({
    content: null,
    steps: 0,
    height: heightOf(text),
  });
  const reading = useRef({
    text,
    isLate: false,
    content: null as Content | null,
    shown: null as Content | null,
    steps: 0,
  });

  useEffect(() => {
    const element = place.current;
    const now = reading.current;
    if (!element) return;
    const putAway = () => {
      now.shown = null;
      const { height } = element.getBoundingClientRect();
      setShowing({ content: null, steps: 0, height });
    };
    return turns.join({
      place: element,
      next: (isNear) => {
        if (now.isLate && isNear) now.content ??= contentOf(now.text, null);
        const { content, shown } = now;
        if (!isNear && shown && shown !== content)
          return { weight: 0, show: putAway };
        const steps = content === shown ? now.steps + 1 : 1;
        if (!content || steps > stepsOf(content)) return null;
        return {
          weight: (content.weight * steps) / stepsOf(content),
          show: () => {
            now.shown = content;
            now.steps = steps;
            setShowing({ content, steps, height: heightOf(content.text) });
          },
        };
      },
      putAway,
    });
  }, [place, turns]);

  useEffect(() => {
    const element = place.current;
    const now = reading.current;
    if (!element) return;
    Object.assign(now, { text, isLate: false, content: null });
    const stopReading = markdownReader.read(
      { text, base },
      () => turns.isNear(element),
      (tree) => {
        if (tree || !now.content) now.content = contentOf(text, tree);
        turns.wake();
      },
    );
    const late = window.setTimeout(() => {
      now.isLate = true;
      turns.wake();
    }, SOON_MS);
    return () => {
      stopReading();
      window.clearTimeout(late);
    };
  }, [place, turns, text, base]);
  return showing;
}

/** Markdown from GitHub. Only the start of a very long one, until asked. */
export const Body = memo(function Body({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > LONG;
  const shown = long && !all ? beginning(text, LONG) : text;
  const place = useRef<HTMLDivElement>(null);
  const { content, steps, height } = useReading(place, shown);
  const isWhole = content !== null && steps === stepsOf(content);
  return (
    <div
      ref={place}
      className="markdown"
      style={isWhole ? undefined : { minHeight: height }}
    >
      {content?.tree ? (
        <Plainly
          key={content.text}
          fallback={<Plain paragraphs={content.paragraphs} />}
        >
          <Markdown tree={content.tree} isWhole={content.text === text} />
        </Plainly>
      ) : (
        content && <Plain paragraphs={content.paragraphs.slice(0, steps)} />
      )}
      {long && (
        <button
          type="button"
          className="pull-link"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
});
