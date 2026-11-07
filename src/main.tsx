import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/variable.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { initializeAppearance } from "./appearance";
import { App } from "./App";
import "./theme.css";
import "./styles/motion.css";

const initialTheme = initializeAppearance();
const root = document.getElementById("root");
if (root === null) throw new Error("The application root is missing.");
createRoot(root).render(
  <React.StrictMode>
    <App initialTheme={initialTheme} />
  </React.StrictMode>,
);
