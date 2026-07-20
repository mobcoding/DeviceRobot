import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const rootElement = document.querySelector("#root");

if (rootElement === null) {
  throw new Error("DeviceRobot root element was not found");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000 },
  },
});

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
