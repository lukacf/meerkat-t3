import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

const decodeCapturedBatch = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      api_key: Schema.String,
      batch: Schema.Array(Schema.Struct({ event: Schema.String })),
    }),
  ),
);

const captureTelemetry = Effect.fnUntraced(function* (
  config: Readonly<Record<string, string | boolean>>,
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let identityReads = 0;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, new Response("{}"));
    }),
  );
  yield* Effect.gen(function* () {
    const analytics = yield* AnalyticsService.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: () =>
          Effect.sync(() => {
            identityReads += 1;
            return '{"tokens":{"account_id":"test-analytics-account"}}';
          }),
      }),
    );
    yield* analytics.record("test.destination", { index: 1 });
    yield* analytics.flush;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-destination-" }),
      ),
    ),
    Effect.scoped,
  );
  return { requests, identityReads };
});

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  const inactiveConfigurations: ReadonlyArray<{
    readonly name: string;
    readonly config: Readonly<Record<string, string | boolean>>;
  }> = [
    { name: "no analytics configuration", config: {} },
    {
      name: "a destination without explicit opt-in",
      config: {
        T3CODE_POSTHOG_KEY: "phc_test_key",
        T3CODE_POSTHOG_HOST: "https://analytics.example.test",
      },
    },
    { name: "opt-in without a destination", config: { T3CODE_TELEMETRY_ENABLED: true } },
    {
      name: "opt-in without a project key",
      config: {
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_HOST: "https://analytics.example.test",
      },
    },
    {
      name: "opt-in without an ingestion host",
      config: { T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test_key" },
    },
    {
      name: "a blank project key",
      config: {
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: "   ",
        T3CODE_POSTHOG_HOST: "https://analytics.example.test",
      },
    },
    {
      name: "a blank ingestion host",
      config: {
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: "phc_test_key",
        T3CODE_POSTHOG_HOST: "   ",
      },
    },
    {
      name: "explicit opt-out with a destination",
      config: {
        T3CODE_TELEMETRY_ENABLED: false,
        T3CODE_POSTHOG_KEY: "phc_test_key",
        T3CODE_POSTHOG_HOST: "https://analytics.example.test",
      },
    },
  ];
  for (const { name, config } of inactiveConfigurations) {
    it.effect(`does not read an identity or send requests with ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* captureTelemetry(config);
        assert.equal(result.identityReads, 0);
        assert.deepEqual(result.requests, []);
      }),
    );
  }

  it.effect("sends only to the explicitly configured ingestion host and project", () =>
    Effect.gen(function* () {
      const result = yield* captureTelemetry({
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: " phc_test_key ",
        T3CODE_POSTHOG_HOST: " https://analytics.example.test ",
      });
      assert.equal(result.identityReads, 1);
      assert.equal(result.requests.length, 1);
      const request = result.requests[0]!;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "https://analytics.example.test/batch/");
      if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON batch body");
      const payload = yield* decodeCapturedBatch(new TextDecoder().decode(request.body.body));
      assert.equal(payload.api_key, "phc_test_key");
      assert.equal(payload.batch.length, 1);
      assert.equal(payload.batch[0]?.event, "test.destination");
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
