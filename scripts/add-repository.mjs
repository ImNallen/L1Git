export function addRepository(browser, root) {
  const palette = 'dialog[aria-label="Add repository"]';
  browser("click", ".repositories-heading button");
  browser("wait", palette);
  browser("find", "role", "option", "click", "--name", "Local folder");
  browser("fill", `${palette} input[aria-label="Path"]`, root);
  browser("wait", `${palette} button[type="submit"]:not([disabled])`);
  browser("click", `${palette} button[type="submit"]`);
}
