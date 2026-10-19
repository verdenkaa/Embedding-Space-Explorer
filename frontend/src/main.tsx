import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./monaco/setup";
import "katex/dist/katex.min.css";
import "./theme/fonts.css";
import "./theme/tokens.css";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
