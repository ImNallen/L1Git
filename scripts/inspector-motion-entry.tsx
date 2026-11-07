import { createRoot } from "react-dom/client";
import { InspectorRegression } from "./inspector-motion";

const root = document.getElementById("root");
if (!root) throw new Error("Missing inspector regression root");
createRoot(root).render(<InspectorRegression />);
