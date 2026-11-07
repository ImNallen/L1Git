import { verifyTableMotion, verifyReducedTableMotion } from "./table-motion";
const box = document.createElement("aside");
box.style.cssText =
  "position:fixed;bottom:20px;left:300px;z-index:99999;background:white;color:black;padding:12px;max-width:600px;font:12px monospace";
const button = document.createElement("button");
button.textContent = "Run table motion checks";
const status = document.createElement("pre");
status.setAttribute("role", "status");
status.textContent = "Ready";
button.onclick = async () => {
  button.disabled = true;
  status.textContent = "Running";
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches)
      await verifyReducedTableMotion();
    else await verifyTableMotion();
    status.textContent = JSON.stringify({
      passed: true,
      engine: navigator.userAgent,
    });
  } catch (error) {
    status.textContent = JSON.stringify({
      passed: false,
      error: String(error),
    });
  }
  button.disabled = false;
};
box.append(button, status);
document.body.append(box);
