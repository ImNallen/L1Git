/** Tab from the place where the files scroll goes to what is in the view, and not to what Pierre drew before it. */
export function tabIntoView(event: KeyboardEvent) {
  const { key, shiftKey, ctrlKey, metaKey, currentTarget: root } = event;
  if (key !== "Tab" || shiftKey || ctrlKey || metaKey) return;
  if (!(root instanceof HTMLElement) || event.target !== root) return;
  const { top } = root.getBoundingClientRect();
  const first = [
    ...root.querySelectorAll<HTMLElement>(".files-header > button"),
  ].find((button) => button.getBoundingClientRect().top >= top);
  if (!first) return;
  event.preventDefault();
  first.focus({ preventScroll: true });
}
