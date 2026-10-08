import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  MeerkatAgentDeliveryReconcileResult,
  MeerkatAgentWork,
  MeerkatProjectAgentAccessMode,
  MeerkatProjectAgentCreateInput,
} from "./meerkatTeam.ts";
const decodeProjectAgentCreate = Schema.decodeUnknownSync(MeerkatProjectAgentCreateInput);

describe("native agent reasoning observations", () => {
  const codec = Schema.fromJsonString(MeerkatAgentWork);
  const decode = Schema.decodeUnknownSync(codec);
  const encode = Schema.encodeSync(codec);
  const work = { status: "idle", observedAt: "2026-10-05T00:00:00.000Z", model: "model" };

  it("keeps unavailable, unknown, default and explicit settings distinct across JSON", () => {
    expect(decode(JSON.stringify(work))).not.toHaveProperty("reasoning");
    for (const reasoning of [
      { kind: "unknown" },
      { kind: "default" },
      { kind: "configured", values: [{ parameter: "reasoning_effort", value: "none" }] },
      {
        kind: "configured",
        values: [
          { parameter: "effort", value: "high" },
          { parameter: "thinking", value: "adaptive" },
        ],
      },
    ]) {
      const observed = decode(JSON.stringify({ ...work, modelProvider: "openai", reasoning }));
      expect(decode(encode(observed))).toMatchObject({ modelProvider: "openai", reasoning });
    }
  });

  it("rejects raw provider controls and empty configured observations", () => {
    for (const values of [[], [{ parameter: "prompt_cache_enabled", value: "false" }]]) {
      expect(() =>
        decode(JSON.stringify({ ...work, reasoning: { kind: "configured", values } })),
      ).toThrow();
    }
  });
});

describe("native delivery reconciliation wire result", () => {
  it("preserves missing and uncertain receipts across JSON without treating either as acceptance", () => {
    const codec = Schema.fromJsonString(MeerkatAgentDeliveryReconcileResult);
    const encode = Schema.encodeSync(codec);
    const decode = Schema.decodeUnknownSync(codec);
    const uncertain = {
      status: "uncertain" as const,
      requestId: "original-request",
      receipt: null,
      message: "Delivery is still uncertain.",
    };
    expect(decode(encode(null))).toBeNull();
    expect(decode(encode(uncertain))).toEqual(uncertain);
    expect(() => decode('{"status":"accepted"}')).toThrow();
  });
});

describe("project specialist permission contract", () => {
  it("accepts only policies supported by the native responsibility host", () => {
    const decode = Schema.decodeUnknownSync(MeerkatProjectAgentAccessMode);
    expect(decode("read-only")).toBe("read-only");
    expect(decode("full-access")).toBe("full-access");
    for (const unsupported of ["approval-required", "auto", "auto-accept-edits", "supervised"])
      expect(() => decode(unsupported)).toThrow();
  });

  it("rejects unsupported permissions at the creation wire boundary", () => {
    expect(() =>
      decodeProjectAgentCreate({
        projectId: "project",
        instanceId: "provider",
        requestId: "request",
        label: "Reviewer",
        role: "reviewer",
        instructions: "Review the repository",
        model: "openai:gpt-5.5",
        accessMode: "approval-required",
      }),
    ).toThrow();
  });
});

describe("project specialist model options contract", () => {
  const input = {
    projectId: "project",
    instanceId: "provider",
    requestId: "request",
    label: "Reviewer",
    role: "reviewer",
    instructions: "Review the repository",
    model: "openai:gpt-5.5",
  };
  const codec = Schema.fromJsonString(MeerkatProjectAgentCreateInput);
  const decode = Schema.decodeUnknownSync(codec);
  const encode = Schema.encodeSync(codec);

  it("preserves omitted options separately from an explicit model default", () => {
    expect(decode(JSON.stringify(input))).not.toHaveProperty("options");
    const explicitDefault = decode(JSON.stringify({ ...input, options: [] }));
    expect(decode(encode(explicitDefault))).toMatchObject({ options: [] });
  });

  it("carries canonical reasoning options and normalizes legacy option objects", () => {
    for (const options of [
      [{ id: "reasoning_effort", value: "high" }],
      { reasoning_effort: "high" },
    ]) {
      const selection = decode(JSON.stringify({ ...input, options }));
      expect(decode(encode(selection))).toMatchObject({
        options: [{ id: "reasoning_effort", value: "high" }],
      });
    }
    expect(() =>
      decode(JSON.stringify({ ...input, options: [{ id: "reasoning_effort", value: 4 }] })),
    ).toThrow();
  });
});
