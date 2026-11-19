import { describe, expect, it } from "vitest";
import { environmentLabel, rememberWorkspace, type Workspace } from "./history";
const entry = (id: string): Workspace => ({ id, path: `/projects/${id}`, environment: { kind: "linux" } });
describe("recent folders", () => {
  it("moves an existing workspace to the front without duplicating it", () => {
    expect(rememberWorkspace([entry("a"), entry("b")], entry("b")).map(x => x.id)).toEqual(["b", "a"]);
  });
  it("caps history at twenty", () => {
    expect(rememberWorkspace(Array.from({length: 20}, (_, i) => entry(`${i}`)), entry("new"))).toHaveLength(20);
  });
  it("identifies WSL distro explicitly", () => {
    expect(environmentLabel({kind: "wsl", distro: "Ubuntu"})).toBe("Ubuntu · WSL");
  });
});
