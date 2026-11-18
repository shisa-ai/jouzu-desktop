import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/context";
import { createJouzuApi } from "./api/adapters";
import { HostClient } from "./api/host-client";
import { configureSessionPool } from "./session-store";
import { configureAppView } from "./app-view";
import { configureEventRouter } from "./event-router";
import "./styles.css";

/**
 * The shell injects the host endpoint before this script runs. Every data call goes
 * there; the page has no second source and therefore needs no remote IPC permission.
 */
declare global {
  interface Window {
    __JOUZU_HOST__?: { baseUrl: string; token: string };
  }
}

const endpoint = window.__JOUZU_HOST__ ?? {
  // A browser on the host origin authenticates with the host cookie. Native
  // actions remain unavailable through the WebApi adapter.
  baseUrl: window.location.origin,
  token: "",
};
if (!endpoint.baseUrl) {
  throw new Error("The host endpoint is missing; start the app through the desktop shell.");
}

// Chat sessions are owned by the host process. StrictMode's development-only double
// mount would attach the same session twice, so the app mounts once.
const client = new HostClient({ baseUrl: endpoint.baseUrl, token: endpoint.token });
const api = createJouzuApi(client);
configureSessionPool(api);
configureEventRouter(client);
configureAppView(client);

async function boot() {
  try { await api.start(); } catch { /* The App surfaces the host error; it never falls back. */ }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>,
  );
}
void boot();
