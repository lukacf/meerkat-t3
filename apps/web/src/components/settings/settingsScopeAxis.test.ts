import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentDiscriminator,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("compact environment discriminators", () => {
  const discriminators = (environments: (typeof first)[]) =>
    environments.map((environment) =>
      settingsScopeEnvironmentDiscriminator(environment, environments),
    );

  it("keeps loopback ports distinct without the repeated address prefix", () => {
    expect(
      discriminators([
        { ...first, displayUrl: "http://127.0.0.1:15810" },
        { ...second, displayUrl: "http://127.0.0.1:3774" },
      ]),
    ).toEqual([":15810", ":3774"]);
  });

  it("keeps short, unique remote hosts readable", () => {
    expect(discriminators([first, second])).toEqual(["first.example.com", "second.example.com"]);
  });

  it("uses distinct identities when the same name also has the same address", () => {
    const environments = [
      {
        ...first,
        environmentId: EnvironmentId.make("a8305d44-1111"),
        displayUrl: "http://localhost:3774",
      },
      {
        ...second,
        environmentId: EnvironmentId.make("a8305d45-2222"),
        displayUrl: "http://127.0.0.1:3774",
      },
    ];
    expect(discriminators(environments)).toEqual(["#a8305d44", "#a8305d45"]);
    expect(discriminators(environments.toReversed())).toEqual(["#a8305d45", "#a8305d44"]);
  });

  it("uses identities for long or invalid addresses without clipping their shared prefix", () => {
    expect(
      discriminators([
        { ...first, displayUrl: "https://first.very-long-environment-name.example.com" },
        { ...second, displayUrl: "unavailable" },
      ]),
    ).toEqual(["#first", "#second"]);
  });

  it("needs no discriminator after the duplicate environment is renamed", () => {
    expect(discriminators([first, { ...second, label: "Production" }])).toEqual([null, null]);
  });
});

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});
