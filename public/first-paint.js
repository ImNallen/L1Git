try {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const saved = JSON.parse(localStorage.getItem("l1git.firstPaint") ?? "null");
  const paint = saved?.[dark ? "dark" : "light"] ?? {
    appearance: dark ? "dark" : "light",
    properties: {},
  };
  const root = document.documentElement;
  root.dataset.theme = paint.appearance;
  root.style.colorScheme = paint.appearance;
  const properties = Object.entries(paint.properties);
  for (const [name, value] of properties)
    if (name.startsWith("--")) root.style.setProperty(name, value);
  root.toggleAttribute("data-palette", properties.length > 0);
} catch {}
