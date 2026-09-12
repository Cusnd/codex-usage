import "@fontsource-variable/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { MotionNavigation } from "../motion/MotionPrimitives.js";
import "../ui/styles/tokens.css";
import "../ui/styles/base.css";
import "../ui/styles/components.css";
import "./layout.css";
import "../features/analysis/analysis.css";
import "../features/settings/settings.css";
import "../ui/styles/responsive.css";
import "../motion/motion.css";
export function mountApplication(wrap: (children: ReactNode) => ReactNode) {
const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        {wrap(<MotionNavigation><App /></MotionNavigation>)}
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

}
