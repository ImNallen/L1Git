import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InspectorRegression, verifyInspectorMotion } from "./inspector-motion";
import {
  ProductionMotionRegression,
  verifyProductionMotion,
} from "./production-motion";
function Harness() {
  const [result, setResult] = useState("Ready");
  return (
    <>
      <InspectorRegression />
      <ProductionMotionRegression />
      <button
        disabled={result !== "Ready"}
        onClick={async () => {
          setResult("Running");
          try {
            const inspector = await verifyInspectorMotion();
            const production = await verifyProductionMotion();
            setResult(JSON.stringify({ passed: true, inspector, production }));
          } catch (error) {
            setResult(JSON.stringify({ passed: false, error: String(error) }));
          }
        }}
      >
        Run motion regressions
      </button>
      <pre role="status">{result}</pre>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing inspector regression root");
createRoot(root).render(<Harness />);
