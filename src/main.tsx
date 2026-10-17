import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { initializeAppearance } from "./appearance";
import { App } from "./App";
import "./theme.css";

const initialTheme = initializeAppearance();
const root = document.getElementById("root");
if (root === null) throw new Error("The application root is missing.");
createRoot(root).render(
  <React.StrictMode>
    <App initialTheme={initialTheme} />
  </React.StrictMode>,
);
