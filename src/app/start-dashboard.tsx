import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { McpResponse } from "../contracts/mcp-response";
import { ingestDashboardResponse } from "./dashboard/dashboard-response";
import { SetupGate } from "./setup/setup-gate";
import "./styles.css";

function readSnapshot(): McpResponse | null {
  const element = document.getElementById("mcp-snapshot");
  if (!element?.textContent) return null;
  try {
    return ingestDashboardResponse(JSON.parse(element.textContent));
  } catch {
    return null;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Could not start the dashboard: missing #root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <SetupGate initialData={readSnapshot()} />
  </StrictMode>,
);
