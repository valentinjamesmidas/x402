import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => registration.active?.postMessage("CACHE_SHELL_ASSETS"))
    .catch(() => undefined);
}
