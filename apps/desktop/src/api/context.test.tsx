import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ApiProvider, useApi } from "./context";
import { WebApi } from "./adapters";
import { HostClient } from "./host-client";

function Probe() {
  const api = useApi();
  return <span>{api.capabilities.scopes.join(",")}</span>;
}

const api = new WebApi(
  new HostClient({
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  }),
);

describe("ApiProvider", () => {
  test("exposes the platform API through the abstract parent", () => {
    const html = renderToStaticMarkup(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );
    expect(html).toContain("loopback");
  });

  test("fails closed without a provider", () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ApiProvider/u);
  });
});
