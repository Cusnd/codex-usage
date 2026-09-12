import "@fontsource-variable/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { cloudMode } from './runtime';
import { CloudGate } from './CloudWorkspace';
import { MotionNavigation } from "./MotionPrimitives";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/analysis.css";
import "./styles/settings.css";
import "./styles/responsive.css";
import "./motion.css";
const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        {cloudMode ? <CloudGate><MotionNavigation><App /></MotionNavigation></CloudGate> : <MotionNavigation><App /></MotionNavigation>}
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
